# Pixl File Manager

A reliable file manager for the **Pixl.js** amiibo emulator over Bluetooth, built as a
replacement for the flaky pixl.amiibo.xyz page. It runs in your own browser and talks
directly to the device. Your files never go to the internet.

## Start it

**Open <https://tronvondoom.github.io/pixl-file-manager/> in Chrome or Edge**, on a
computer or an Android phone. Then:

1. On the Pixl.js, open **BLE File Transfer** from the main menu.
2. Click **Connect device** and pick **Pixl.js** from the list.

Click **Install app** in the top bar to get an app with its own icon that also opens
offline. Want to look around first? Click **Try the demo**. It runs an emulated device in
memory.

The page runs entirely in your browser. Files go straight between the browser and the
device; the website only delivers the app itself.

**Running it from this folder instead:** double-click **`Start Pixl File Manager.bat`**.
It serves the app on `http://localhost:8642`, which only this computer can reach, and
opens it in Chrome or Edge. Keep the console window open while you use it. Browsers only
allow Bluetooth on `https://` pages or `localhost`, which is why a plain double-click on
`index.html` isn't enough. Firefox and Safari don't support Web Bluetooth.

## What it does

| | |
|---|---|
| **Amiibo names & pictures** | Every amiibo shows its name, series and picture. The **picture grid** (top right) lets you browse visually, and the filter box searches by character, series or game |
| **Browse** | Drives, folders, breadcrumbs, back/forward, sorting (including by amiibo name), and a free-space meter |
| **Upload** | Drag files *or whole folders* onto the window or onto a folder, or use **Upload ▾** |
| **Smart uploads** | Flipper Zero `.nfc` and Proxmark `.eml` dumps convert to `.bin` automatically, files the Pixl.js can't load are flagged, and you can sort amiibo into **series folders** or **rename them to the figure's name**. Existing files are never overwritten |
| **Download & backup** | One file downloads as-is. Several files or folders download as one `.zip`. Use **Back up whole drive** in the drive's ⋯ menu to save everything |
| **Restore** | **Upload ▾ → Restore from ZIP backup**, or drop a `.zip` onto the window |
| **Sync with a PC folder** | **Sync** compares a Pixl.js folder with a folder on your computer (by content, since amiibo files are all the same size), shows exactly what will change, then copies only the differences, in one direction or both |
| **Duplicates** | **Find duplicate amiibo** (drive menu or right-click). Identical copies are pre-selected for deletion; different saves of the same figure are not |
| **Copy / move** | Copy, Cut, Paste (Ctrl+C / X / V), or drag rows onto a folder or breadcrumb (hold Ctrl to copy) |
| **Organize** | New folder, rename (F2), delete (Del, folders included), notes / hidden / read-only (Properties) |
| **Firmware update** | **Update firmware…** in the sidebar installs a `pixjs_ota_vXXX.zip` package over Bluetooth |
| **Format** | In the drive's ⋯ menu, with a type-to-confirm step |

Keyboard: arrows, Shift/Ctrl-click selection, Enter opens, Backspace goes up, F5
refreshes, Ctrl+A selects all, Ctrl+F filters.

**Settings** (gear icon):
- Amiibo names and pictures (on or off).
- Upload review.
- Verify uploads.
- **Fast transfers (experimental):** sends several packets per confirmation. Try it with
  big files, and compare the speed shown in the Transfers panel. It switches itself off if
  the device can't keep up.

### About amiibo names

Names and pictures come from the open
[AmiiboAPI](https://github.com/N3evin/AmiiboAPI) database on GitHub. The app downloads it
once and keeps a copy. The only requests are for that public file and the pictures;
nothing about your files is sent. To learn which amiibo a file is, the app reads it once
(540 bytes) when the device is idle, then remembers the answer on this computer.

### About firmware updates

Pixl.js uses Nordic's standard secure bootloader, the same one the official update page
and nRF Connect talk to. Use the **OTA package** (`pixjs_ota_vXXX.zip`, inside the firmware
download) that matches your screen, **LCD** or **OLED**. If an update is interrupted, the
old firmware keeps working. To retry, open **Settings → Firmware Update** on the device. If
the screen is blank because the wrong package went on, the button sequence in the official
docs puts the device back into update mode.

## Why it's more reliable than the stock page

I read the firmware source (`fw/application/src/mod/df`, `mod/vfs`) and the stock web
app's protocol code, then fixed the problems I found in both:

- **No more frozen queue.** The stock page waits forever for every reply, so one lost
  Bluetooth packet hangs everything until you reload. Here every request has a timeout
  and is retried.
- **Lost packets are caught.** Chunk sequence numbers are checked, so a gap can't quietly
  produce a corrupt file.
- **Resumable uploads.** If a write is interrupted, the app commits what the device has,
  reads back how many bytes actually landed, and continues from there.
- **Gap-filling downloads.** The firmware can't seek, so a lost packet would mean starting
  over. Instead, the app re-reads and fills in only the missing pieces.
- **Verified uploads** (on by default). Every uploaded or copied file is read back and
  compared byte for byte.
- **Auto-reconnect.** If the link drops, the app reconnects on its own and pending
  transfers pick up where they stopped.
- **Folder rename works.** The firmware's folder rename is broken (it renames the folder
  to its own name and reports success). The app moves the contents into a new folder
  instead.
- **Deleting folders works.** The firmware refuses to delete a non-empty folder, so the
  app deletes the contents first.
- **Correct free space.** The stock page shows the firmware's *free* bytes as *used*.
- **Names that fit.** The device limits names to 47 bytes and paths to 63 bytes. The app
  checks this up front and offers to shorten names, rather than failing halfway through.

## Troubleshooting

- **The device doesn't show up in the picker.** Make sure BLE File Transfer is open on the
  Pixl.js and that Bluetooth is on in Windows. Turning the device's BLE app off and on
  again usually helps.
- **It connects, then drops.** The app reconnects on its own. If that keeps failing, move
  closer, and check that no other tab or app (such as the stock page) is connected to the
  device.
- **Something failed.** Open the **Activity log** tab at the bottom. **Show packets** adds
  raw protocol traces, and **Copy** puts the log on your clipboard.

## For developers

```
index.html                 the app
css/app.css                styles (light & dark)
js/protocol.js             Pixl.js BLE file protocol client (framing, retries, resume, fast mode)
js/transport-ble.js        Web Bluetooth (Nordic UART Service) transport
js/amiibo.js               amiibo IDs, AmiiboAPI lookups, .nfc/.eml conversion
js/zip.js / js/unzip.js    ZIP writer and reader
js/sync.js                 PC folder sync (File System Access API)
js/dfu.js                  Nordic Secure DFU client (firmware updates)
js/firmware-ui.js          firmware update screens
js/mock-device.js          firmware emulator for the demo and tests
js/mock-dfu.js             bootloader emulator for the demo and tests
js/app.js                  user interface
sw.js, manifest.webmanifest, icons/   installable app / offline support
tests/                     automated tests
server.ps1, Start Pixl File Manager.bat   local launcher
```

**Tests:** run `node tests/run-node.js`, or open `tests/index.html` through the launcher.
They exercise the protocol against the firmware emulator, including deliberately lost
packets, dropped connections, fast mode, the amiibo tools, ZIP, firmware updates and
sync logic.

**URL options:**
- `?demo` auto-starts the demo.
- `?demo&faults=0.05` makes the emulator drop 5% of replies, to test recovery.
- `&latency=30` sets the per-packet delay in milliseconds.
