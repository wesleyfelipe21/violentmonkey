import { isEmpty, sendTabCmd } from '@/common';
import { forEachEntry, forEachValue, nest, objectGet, objectSet } from '@/common/object';
import { getScript } from './db';
import { addOwnCommands, addPublicCommands } from './message';
import storage, { S_VALUE } from './storage';
import { getFrameDocIdAsObj, getFrameDocIdFromSrc } from './tabs';

/** { scriptId: { tabId: { frameId: {key: raw}, ... }, ... } } */
const openers = {};
let chain = Promise.resolve();
let toSend = {};

addOwnCommands({
  async GetValueStore(id, { tab }) {
    const frames = nest(nest(openers, id), tab.id);
    const values = frames[0] || (frames[0] = await storage[S_VALUE].getOne(id));
    return values;
  },
  /**
   * @param {Object} data - key can be an id or a uri
   * @return {Promise<void>}
   */
  SetValueStores(data) {
    const toWrite = {};
    data::forEachEntry(([id, store = {}]) => {
      id = getScript({ id: +id, uri: id })?.props.id;
      if (id) {
        toWrite[id] = store;
        toSend[id] = store;
      }
    });
    commit(toWrite);
    return chain;
  },
});

addPublicCommands({
  /**
   * @return {?Promise<void>}
   */
  UpdateValue({ id, key, raw }, src) {
    const values = objectGet(openers, [id, src.tab.id, getFrameDocIdFromSrc(src)]);
    if (values) { // preventing the weird case of message arriving after the page navigated
      if (raw) values[key] = raw; else delete values[key];
      nest(toSend, id)[key] = raw || null;
      commit({ [id]: values });
      return chain;
    }
  },
});

export function clearValueOpener(tabId, frameId) {
  if (tabId == null) {
    toSend = {};
  }
  openers::forEachEntry(([id, tabs]) => {
    const frames = tabs[tabId];
    if (frames) {
      if (frameId) {
        delete frames[frameId];
        if (isEmpty(frames)) delete tabs[tabId];
      } else {
        delete tabs[tabId];
      }
    }
    if (tabId == null || isEmpty(tabs)) {
      delete openers[id];
    }
  });
}

/**
 * @param {VMInjection.Script[] | number[]} injectedScripts
 * @param {number} tabId
 * @param {number|string} frameId
 */
export async function addValueOpener(injectedScripts, tabId, frameId) {
  const valuesById = +injectedScripts[0] // restoring storage for page from bfcache
    && await storage[S_VALUE].getMulti(injectedScripts);
  for (const script of injectedScripts) {
    const id = valuesById ? script : script.id;
    const values = valuesById ? valuesById[id] || null : script[VALUES];
    if (values) objectSet(openers, [id, tabId, frameId], Object.assign({}, values));
    else delete openers[id];
  }
}

/** Moves values of a pre-rendered page identified by documentId to frameId:0 */
export function reifyValueOpener(ids, documentId) {
  for (const id of ids) {
    openers[id]::forEachValue(frames => {
      if (documentId in frames) {
        frames[0] = frames[documentId];
        delete frames[documentId];
      }
    });
  }
}

function commit(data) {
  storage[S_VALUE].set(data);
  chain = chain.catch(console.warn).then(broadcast);
}

async function broadcast() {
  const tasks = [];
  const toTabs = {};
  toSend::forEachEntry(groupByTab, toTabs);
  toSend = {};
  for (const [tabId, frames] of Object.entries(toTabs)) {
    for (const [frameId, toFrame] of Object.entries(frames)) {
      if (!isEmpty(toFrame)) {
        tasks.push(sendToFrame(tabId, frameId, toFrame));
        if (tasks.length === 20) await Promise.all(tasks.splice(0)); // throttling
      }
    }
  }
  await Promise.all(tasks);
}

/** @this {Object} accumulator */
function groupByTab([id, valuesToSend]) {
  const entriesToSend = Object.entries(valuesToSend);
  openers[id]::forEachEntry(([tabId, frames]) => {
    if (tabId < 0) return; // script values editor watches for changes differently
    const toFrames = nest(this, tabId);
    frames::forEachEntry(([frameId, last]) => {
      const toScript = nest(nest(toFrames, frameId), id);
      entriesToSend.forEach(([key, raw]) => {
        if (raw !== last[key]) {
          if (raw) last[key] = raw; else delete last[key];
          toScript[key] = raw;
        }
      });
    });
  });
}

function sendToFrame(tabId, frameId, data) {
  return sendTabCmd(+tabId, 'UpdatedValues', data, getFrameDocIdAsObj(frameId)).catch(console.warn);
  // must use catch() to keep Promise.all going
}
