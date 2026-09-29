/** One 16x16 frame of a Kenney sheet (public/game/kenney-tiny-*.png, 12 frames per row), scaled up crisply in plain HTML. */
export function Sprite({ sheet, frame, size = 40 }: { sheet: "dungeon" | "town"; frame: number; size?: number }) {
  const s = size / 16;
  return (
    <span
      aria-hidden
      className="inline-block shrink-0"
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${import.meta.env.BASE_URL}game/kenney-tiny-${sheet}.png)`,
        backgroundSize: `${192 * s}px ${176 * s}px`,
        backgroundPosition: `-${(frame % 12) * 16 * s}px -${Math.floor(frame / 12) * 16 * s}px`,
        imageRendering: "pixelated",
      }}
    />
  );
}
