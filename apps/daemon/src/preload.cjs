const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lettaDaemon", {
  cancelEnvironmentName() {
    ipcRenderer.send("daemon:cancel-environment-name");
  },
  saveEnvironmentName(name) {
    return ipcRenderer.invoke("daemon:save-environment-name", name);
  },
});
