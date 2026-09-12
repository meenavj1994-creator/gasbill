'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function call(channel) {
  return function () {
    const args = Array.prototype.slice.call(arguments);
    return ipcRenderer.invoke.apply(ipcRenderer, [channel].concat(args));
  };
}

contextBridge.exposeInMainWorld('api', {
  distributor: { get: call('distributor:get'), save: call('distributor:save') },
  appVersion: call('app:version'),
  branding: { defaultLogo: call('branding:defaultLogo') },
  gst: {
    seriesPrefix: call('gst:seriesPrefix'),
    sampleInvoiceNo: call('gst:sampleInvoiceNo')
  },
  charges: {
    active: call('charges:active'),
    all: call('charges:all'),
    add: call('charges:add'),
    revise: call('charges:revise')
  },
  bundles: {
    list: call('bundles:list'),
    save: call('bundles:save'),
    remove: call('bundles:delete'),
    resolve: call('bundles:resolve')
  },
  consumers: {
    find: call('consumers:find'),
    search: call('consumers:search'),
    import: call('consumers:import'),
    parseFile: call('consumers:parseFile')
  },
  certificate: { read: call('certificate:read') },
  reports: { export: call('reports:export'), period: call('reports:period') },
  saveWorkbook: call('dialog:saveWorkbook'),
  invoice: {
    preview: call('invoice:preview'),
    save: call('invoice:save'),
    get: call('invoice:get'),
    between: call('invoice:between')
  },
  validateGstin: call('gstin:validate'),
  compute: call('compute'),
  taxBreakup: call('taxBreakup'),
  backup: { run: call('backup:run'), last: call('backup:last') },
  pickFolder: call('dialog:pickFolder'),
  print: call('print:invoice'),
  updates: {
    pending: call('update:pending'),
    onReady: function (callback) {
      ipcRenderer.on('update:ready', function (event, version) { callback(version); });
    },
    install: call('update:install')
  },
  markDirty: function (isDirty) { ipcRenderer.send('app:dirty', isDirty); },
  // Electron 32 removed File.path from the renderer; this is the only way
  // left to turn a picked File into a path the main process can open.
  pathOf: function (file) { return file ? webUtils.getPathForFile(file) : null; }
});
