# move-mouse

> MCP Prompt: `move-mouse`

Guide for moving the mouse with `pikvm_mouse_move`.

## Purpose

Move the mouse cursor to an absolute pixel position or by a relative delta.

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| x | number | *(required)* | X coordinate (absolute) or delta (relative) |
| y | number | *(required)* | Y coordinate (absolute) or delta (relative) |
| relative | boolean | false | If true, move relative to current position |
| frameId | string | default frame | Capture whose pixels x and y are in |

## Coordinate Space

- **Absolute mode** (default): pixels in the default click frame, the last full preview in request order. Pass `frameId` to use that capture, including a crop. The point is mapped with that frame's scale, crop origin, and calibration.
- **Relative mode**: Deltas are clamped to -127 to 127 per call. They are not mapped through the frame. An unknown `frameId` is still rejected.

## Example Calls

```json
{ "name": "pikvm_mouse_move", "arguments": { "x": 500, "y": 300 } }

{ "name": "pikvm_mouse_move", "arguments": { "x": -50, "y": 0, "relative": true } }
```

## Tips

- If calibration is active, absolute coordinates are automatically adjusted.
- A **resolution change** will invalidate calibration — you'll see a warning in the response.
- To move and click in one step, use `pikvm_mouse_click` with x/y parameters instead.
