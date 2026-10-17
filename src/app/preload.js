'use strict';
/**
 * 渲染进程与主进程之间的唯一通道。
 * 渲染层拿不到 Node，只能通过这些方法做事。
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('up', {
  bootstrap: () => invoke('app:bootstrap'),

  settings: {
    get: () => invoke('settings:get'),
    save: (patch) => invoke('settings:save', patch),
  },

  platforms: {
    list: () => invoke('platforms:list'),
    template: () => invoke('platforms:template'),
    get: (id) => invoke('platforms:get', id),
    save: (def) => invoke('platforms:save', def),
    remove: (id) => invoke('platforms:remove', id),
    test: (payload) => invoke('platforms:test', payload),
  },

  sources: {
    list: () => invoke('sources:list'),
    add: (input) => invoke('sources:add', input),
    update: (patch) => invoke('sources:update', patch),
    remove: (id) => invoke('sources:remove', id),
    collect: (payload) => invoke('sources:collect', payload),
    sync: (id) => invoke('sources:sync', id),
    loginState: (id) => invoke('sources:loginState', id),
    login: (id) => invoke('sources:login', id),
    followings: (id) => invoke('sources:followings', id),
  },

  posts: {
    list: (query) => invoke('posts:list', query),
    reveal: (relPath) => invoke('posts:reveal', relPath),
    snapshot: (payload) => invoke('posts:snapshot', payload),
  },

  data: {
    reveal: () => invoke('data:reveal'),
    stats: () => invoke('data:stats'),
  },

  log: {
    open: () => invoke('log:open'),
  },

  syncNow: () => invoke('sync:now'),

  autoLaunch: {
    get: () => invoke('autostart:get'),
    set: (enabled) => invoke('autostart:set', enabled),
  },

  links: {
    open: (url) => invoke('shell:open', url),
  },

  /** 主进程事件订阅；返回取消订阅函数。 */
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  },
});
