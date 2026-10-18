# take-screenshot

> MCP Prompt: `take-screenshot`

Guide for capturing screenshots with `pikvm_screenshot`.

## Purpose

Capture the current screen of the remote machine as a JPEG image. This is your primary way to **see** what is on screen.

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| maxWidth | number | 960 | Maximum preview width. Omitted uses the device default |
| maxHeight | number | 600 | Maximum preview height. Omitted uses the device default |
| quality | number | 70 | JPEG quality (1-100). Omitted uses the device default |

Scaling preserves aspect ratio. The default click frame is the last full preview, in request order. A crop does not change it. Pass the capture's `frameId` to a mouse tool to use that image, including a crop.

## Example Call

```json
{
  "name": "pikvm_screenshot",
  "arguments": { "maxWidth": 1280, "quality": 70 }
}
```

## Tips

- The defaults are 960×600 at quality 70. Pass a larger maxWidth and maxHeight when you need a bigger preview.
- Use lower quality (50-60) when you only need layout/position information to save bandwidth.
- Always take a screenshot **after** performing an action to verify the result.
- The response includes a text line describing dimensions and any scaling that was applied.
