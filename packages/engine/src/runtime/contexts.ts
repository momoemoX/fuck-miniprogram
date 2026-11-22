export const CONTEXT_METHODS = {
  AudioContext: ['play', 'pause', 'seek', 'setSrc'],
  EditorContext: [
    'blur', 'clear', 'deleteText', 'format', 'getBounds', 'getContents', 'getHistoryState', 'getSelection',
    'getSelectionText', 'insertCustomBlock', 'insertDivider', 'insertImage', 'insertText', 'redo',
    'removeFormat', 'scrollIntoView', 'setContents', 'setSelection', 'undo'
  ],
  MapContext: [
    'getCenterLocation', 'getScale', 'getRotate', 'getRegion', 'moveToLocation', 'includePoints', 'translateMarker',
    'toScreenLocation', 'fromScreenLocation', 'setCenterOffset', 'addMarkers', 'removeMarkers',
    'addGroundOverlay', 'updateGroundOverlay', 'removeGroundOverlay'
  ],
  VideoContext: ['play', 'pause', 'stop', 'seek', 'playbackRate', 'requestFullScreen', 'exitFullScreen', 'sendDanmu', 'showStatusBar', 'hideStatusBar', 'exitPictureInPicture'],
  SelectionContext: ['removeSelection', 'selectRange', 'setBaseAndExtent']
} as const;

export type ContextShape<Name extends keyof typeof CONTEXT_METHODS> = Record<
  (typeof CONTEXT_METHODS)[Name][number], (...args: any[]) => unknown
>;
