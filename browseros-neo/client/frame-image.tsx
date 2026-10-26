import { memo, useCallback, useMemo } from "react";
import { Image } from "react-native";
import type { Frame } from "../shared/contracts.ts";
import { frameImageUri } from "./frame-buffer.ts";

interface Props {
  frame: Frame;
  index: number;
  width: number;
  height: number;
  onLoad(frame: Frame, index: number): void;
  onError(frame: Frame): void;
}

/** Keep a decoded buffer's large data URI and native image props stable. */
export const FrameImage = memo(function FrameImage({ frame, index, width, height, onLoad, onError }: Props) {
  const { mimeType, image } = frame;
  const source = useMemo(() => ({ uri: frameImageUri(mimeType, image ?? "") }), [mimeType, image]);
  const loaded = useCallback(() => onLoad(frame, index), [onLoad, frame, index]);
  const failed = useCallback(() => onError(frame), [onError, frame]);
  return (
    <Image
      source={source}
      fadeDuration={0}
      resizeMode="stretch"
      accessibilityLabel="Live BrowserOS window"
      style={{ width, height }}
      onLoad={loaded}
      onError={failed}
    />
  );
});
