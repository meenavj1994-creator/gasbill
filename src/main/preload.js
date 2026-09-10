'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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
  consumers: {
    find: call('consumers:find'),
    search: call('consumers:search'),
    import: call('consumers:import'),
    parseFile: call('consumers:parseFile')
  },
  certificate: { read: call('certificate:read') },
  reports: { export: call('reports:export') },
  saveWorkbook: call('dialog:saveWorkbook'),
  invoice: {
    preview: call('invoice:preview'),
    save: call('invoice:save'),
    get: call('invoice:get'),
    between: call('invoice:between')
  },
  validateGstin: call('gstin:validate'),
  compute: call('compute'),
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
  markDirty: function (isDirty) { ipcRenderer.send('app:dirty', isDirty); }
});
