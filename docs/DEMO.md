# Demo process for converting a video to a GIF using FFmpeg with an optimal palette.

## Configure VSCode window
For precise sizing, resize VS Code to exact pixel dimensions via the Developer Tools console: open `Toggle Developer Tools`, go to the Console tab, and run:

```javascript
window.resizeTo(1024, 768)
```
## Record
Record MP4 video of a VSCode window using tools like OBS, Captura...

## Convert to GIF with FFmpeg

```powershell
# Step 1: generate optimal palette
ffmpeg -i demo.mp4 -vf "fps=15,scale=1024:-1:flags=lanczos,palettegen=stats_mode=diff" palette.png

# Step 2: apply palette during conversion
ffmpeg -i demo.mp4 -i palette.png -filter_complex "fps=15,scale=1024:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5" -loop 0 demo.gif
```