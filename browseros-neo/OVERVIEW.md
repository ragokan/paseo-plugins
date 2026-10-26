Shows the BrowserOS window running on the daemon's Linux desktop inside Paseo, and lets you use it from there: click, scroll, drag and type into it as if you sat at that machine. It is the whole window as the desktop draws it, with BrowserOS's tab sidebar, toolbar, agent rail, menus and popups, not just the page. Open it from the BrowserOS Neo row in the sidebar or from the command center, on the desktop app, in a browser, or on iOS and Android.

## Setup

- The daemon must run on Linux with an X11 desktop session where BrowserOS is open. Wayland sessions are not supported.
- The daemon machine needs `python3` with PyGObject (GTK 3's GDK and GdkPixbuf) and `libXtst`. GNOME and most desktop installs include them; on Debian and Ubuntu they come from `python3-gi`, `gir1.2-gtk-3.0` and `libxtst6`.
- The daemon has to reach the display. It uses `DISPLAY` and `XAUTHORITY` from its environment, or `:0` and `~/.Xauthority` when they are unset.
- Turn off the desktop's screen lock: input goes to whatever is on screen, and a lock screen would take it.
- Matching the resolution to your device needs `xrandr` and a virtual display, such as Xorg's dummy driver on a headless machine. On a real monitor the view still works, scaled to fit.

## How it works

- The screen starts disconnected and shows a Connect button. Until you press it, nothing is captured, resized or sent. Disconnect, next to the Live indicator, stops it again. The choice lasts until the app restarts.
- While connected, the screen asks the daemon for a frame, and the daemon answers as soon as the window changes, or after a second and a half without change. The X server tells the daemon when BrowserOS redraws, so a still window costs almost nothing. Frames are JPEGs sized to the screen showing them, so a phone gets a smaller one than a desktop. On a local network a change shows up in about 40 ms. Streaming pauses while the screen is hidden: another Paseo screen such as a chat, a background tab, a minimized window, or the iOS and Android app in the background.
- Quality Mode, next to Disconnect, keeps the same size and spends more data on it: frames go as higher-quality JPEG while the page moves, and as soon as it is still for a moment the daemon sends the same picture again as lossless PNG, so text is exact. A still frame that would be over 1.5 MB as PNG, such as a large photo, goes as a high-quality JPEG instead. Without it, frames are JPEG only, which uses less data.
- The desktop takes the size of the view you are looking from. On a laptop or a large monitor, a maximized BrowserOS gets exactly the size of the view, so its text appears at its normal size. Phones get at least 800x600 in the phone's shape, so the tab sidebar still fits. The daemon grows or shrinks the virtual screen around BrowserOS to do it, which RustDesk and other desktop viewers see too. When several devices are open, the one you last resized or touched wins. A minute after the last view closes, and when the plugin stops, the desktop returns to its original resolution.
- Several BrowserOS windows show as a picker above the view. The view starts on the largest window and stays on the one you are looking at until you pick another or it closes, so agents and popups taking focus do not move it.
- Input goes in through the X server as real mouse and keyboard events. The daemon brings the window to the front first, so the desktop's own pointer moves with your clicks.
- On the desktop and web apps, click into the view to type; keys go to BrowserOS until you click outside it. Command shortcuts from a Mac arrive as Ctrl, and paste sends your own clipboard's text.
- On phones and tablets, in the iOS and Android apps or in a browser, tap to click, hold for a right click, and drag to scroll. The keyboard button opens a text field with keys such as Address bar, Enter, Tab, Esc and the arrows. In the iOS and Android apps, Zoom shows the window at full size to pan around.
- When BrowserOS is not running, the screen offers a button to start it.

## Limits

- Frames travel over your Paseo connection, and only when the picture changes. While the page moves, the stream stays under 3 MB/s, or 5 MB/s in Quality Mode, and at most 30 frames a second; at a laptop-sized view that is about 14 and 17 frames a second. Slower links get fewer frames. An animation anywhere in the window, such as a spinner, makes every frame count as changed.
- While the page moves, the daemon's capture uses about a third of one CPU core; while it is still, a few percent.
- Resizing BrowserOS changes the page size your BrowserOS agents work with too.
- Clipboard contents copied inside BrowserOS do not come back to your device.
- The view does not show the desktop's mouse cursor.
