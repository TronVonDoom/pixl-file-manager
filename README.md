# Pixl File Manager

A reliable file browser for the **Pixl.js** amiibo emulator over Bluetooth, built as a
replacement for the flaky pixl.amiibo.xyz page. It runs in your own browser and talks
directly to the device. Nothing goes to the internet.

## Start it

1. Double-click **`Start Pixl File Manager.bat`**. A small console window opens, and so
   does the app (in Chrome if it's installed, otherwise Edge). Keep the console window
   open while you use the app. Closing it stops the app.
2. On the Pixl.js, open **BLE File Transfer** from the main menu.
3. Click **Connect device** and pick **Pixl.js** from the list.

Want to look around first? Click **Try the demo**. It runs an emulated device in memory.

> Why a launcher? Browsers only allow Bluetooth on `https://` pages or on
> `http://localhost`. The launcher serves this folder on `http://localhost:8642`, and only
> this computer can reach it. Firefox and Safari don't support Web Bluetooth, so use
> Chrome or Edge.

## What it does

| | |
|---|---|
| **Browse** | Drives, folders, breadcrumbs, back/forward, sorting, a filter box, and a free-space meter |
| **Upload** | Drag files *or whole folders* onto the window, or onto a folder row, or use **Upload ▾** |
| **Download** | One file downloads as-is. Several files or folders download as one `.zip`. Use **Back up whole drive** (the drive's ⋯ menu) to save everything at once |
| **Copy / move** | Copy, Cut, Paste (Ctrl+C / X / V), or drag rows onto a folder or breadcrumb (hold Ctrl to copy). Works across folders and drives |
| **Organize** | New folder, rename (F2), delete (Del, folders included), notes / hidden / read-only (Properties) |
| **Format** | In the drive's ⋯ menu, with a type-to-confirm step |

Keyboard: arrows, Shift/Ctrl-click selection, Enter opens, Backspace goes up, F5
refreshes, Ctrl+A selects all, Ctrl+F filters.

## Why it's more reliable than the stock page

I read the firmware source (`fw/application/src/mod/df`, `mod/vfs`) and the stock web
app's protocol code, then fixed the problems I found in both:

- **No more frozen queue.** The stock page waits forever for every reply, so one lost
  Bluetooth packet hangs everything until you reload. Here every request has a timeout
  and is retried.
- **Lost packets are caught.** Chunk sequence numbers are checked. A gap is treated as an
  error and retried, so it can't quietly produce a corrupt file.
- **Resumable uploads.** If a write is interrupted, the app commits what the device has,
  reads back how many bytes actually landed, and continues from there.
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
- File operations are serialized under one lock, because the firmware has only one
  open-file slot.

## Troubleshooting

- **The device doesn't show up in the picker.** Make sure BLE File Transfer is open on the
  Pixl.js and that Bluetooth is on in Windows. Turning the device's BLE app off and on
  again usually helps.
- **It connects, then drops.** The app reconnects on its own. If that keeps failing, move
  closer, and check that no other tab or app (such as the stock page) is connected to the
  device.
- **Something failed.** Open the **Activity log** tab at the bottom. **Show packets** adds
  raw protocol traces, and **Copy** puts the log on your clipboard.

## Files

```
index.html                 the app
css/app.css                styles (light & dark)
js/protocol.js             Pixl.js BLE file protocol client (framing, retries, resume)
js/transport-ble.js        Web Bluetooth (Nordic UART Service) transport
js/mock-device.js          in-memory firmware emulator used by the demo
js/zip.js                  ZIP writer for multi-file downloads
js/app.js                  user interface
server.ps1                 tiny localhost web server
Start Pixl File Manager.bat  launcher
```

Developer URL options: `?demo` auto-starts the demo, `?demo&faults=0.05` makes the
emulator drop 5% of replies (to test recovery), and `&latency=30` sets a per-packet delay
in ms.
