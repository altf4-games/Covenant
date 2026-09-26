import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import { WorldScene } from "../game/scenes/WorldScene";
import { buildQuest, WORLD_COLS, WORLD_ROWS, TILE, HEADER_HEIGHT } from "../game/logic";
import { bossFor, tokenName, type Decision } from "../lib/covenant";

interface GameCanvasProps {
  decisions: Decision[];
  /** Called the moment the player actually starts the replay (not on load). */
  onStart?: () => void;
}

// A short pause between the player clicking start and the hero's first
// step - instant playback read as the game "auto-playing itself" rather
// than something the player triggered.
const QUEST_START_DELAY_MS = 900;

/**
 * The real 2D game (replaces the earlier emoji-based BossBattle/TerritoryMap
 * pair): Phaser 3, real CC0 sprites from Kenney's "Tiny Dungeon" and
 * "Tiny Town" packs (frontend/assets-src/, see the LICENSE.txt kept there),
 * not an AI-styled decoration layer. A hero walks the real territory map
 * toward wherever a real decision actually traded, and a real denial
 * triggers a real battle screen against the boss sprite for that
 * DenialReason - the queue and every position on the map come from
 * frontend/src/game/logic.ts, unit-tested independently of Phaser/canvas
 * rendering (which needs a real browser to verify - see this component's
 * manual browser verification in the session that built it).
 */
export function GameCanvas({ decisions, onStart }: GameCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<WorldScene | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;
    const width = WORLD_COLS * TILE;
    const height = WORLD_ROWS * TILE + HEADER_HEIGHT;
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      width,
      height,
      parent: containerRef.current,
      backgroundColor: "#0b0d10",
      scene: [WorldScene],
      // pixelArt forces nearest-neighbor texture filtering (crisp sprites
      // at every scale step); antialias/roundPixels off keeps Phaser's own
      // text and shape rendering crisp too, rather than anti-aliased and
      // then blurred further by FIT's canvas upscale.
      render: { pixelArt: true, antialias: false, roundPixels: true },
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width,
        height,
      },
    });
    gameRef.current = game;
    // Belt-and-suspenders: `render.pixelArt` should already make Phaser set
    // this, but only on the browsers where its own default matches - set it
    // explicitly so FIT's CSS-level canvas upscale never falls back to the
    // browser's default bilinear smoothing.
    game.canvas.style.imageRendering = "pixelated";
    // The scene object doesn't exist yet at all right after `new
    // Phaser.Game(...)` - the SceneManager adds it during boot, which
    // happens on a later tick. Wait for the Game's own READY event first
    // (boot complete, scene object now exists), THEN wait for that SCENE's
    // own CREATE event before touching it. "ready" alone isn't enough:
    // preload() loads real image files asynchronously, so create() (which
    // actually assigns this.hero/this.battleLayer) can still be pending
    // when "ready" fires - calling playQuest() in that window was the real
    // cause of the earlier "Cannot read properties of undefined" crash.
    game.events.once(Phaser.Core.Events.READY, () => {
      const scene = game.scene.getScene("world") as WorldScene;
      sceneRef.current = scene;
      const onCreated = () => {
        scene.setOnStep((step) => {
          setCurrent(step ? step.decisionId : null);
        });
        setReady(true);
      };
      // In case CREATE already fired between boot and this handler
      // running (e.g. cached assets loading instantly).
      if (scene.sys.settings.status >= Phaser.Scenes.RUNNING) {
        onCreated();
      } else {
        scene.events.once(Phaser.Scenes.Events.CREATE, onCreated);
      }
    });
    return () => {
      game.destroy(true);
      gameRef.current = null;
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Gated behind an explicit player click (see the "▶ START" overlay
    // below) - the world used to start replaying decisions, battles and
    // all, the instant the page loaded, before the player had even seen
    // the map. A short delay on top of that so the first step still reads
    // as "the player just started this" rather than instant playback.
    if (!ready || !started || !sceneRef.current) return;
    const scene = sceneRef.current;
    const id = setTimeout(() => scene.playQuest(buildQuest(decisions)), QUEST_START_DELAY_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, started, decisions]);

  const currentDecision = decisions.find((d) => d.id === current);
  const currentBoss = currentDecision?.commit && !currentDecision.commit.allowed ? bossFor(currentDecision.commit.reason) : null;

  return (
    <div className="relative h-full w-full overflow-hidden bg-[var(--panel)]">
      {/* Fullscreen game - no HTML chrome shrinking the canvas. Zone labels
          render inside the canvas itself (WorldScene.drawWorld); this is
          just a thin status strip overlaid on top of the game, not beside
          it, per direction that the panels/HUD "can be in game only".
          Plain `absolute inset-0`, no flex centering here - Phaser's own
          CENTER_BOTH scale mode already positions the canvas within this
          div via inline margin styles, and the two centering systems
          fighting each other was leaving the canvas pinned near the
          bottom instead of centered on a fresh page load. */}
      <div ref={containerRef} className="absolute inset-0" />
      {!ready && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[var(--bg)]">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
          <p className="font-pixel text-[10px] tracking-widest text-[var(--muted)]">LOADING WORLD…</p>
        </div>
      )}
      {ready && !started && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/35">
          <button
            onClick={() => {
              setStarted(true);
              onStart?.();
            }}
            className="font-pixel animate-pulse rounded border-2 border-[var(--text)] bg-[var(--panel)] px-6 py-3 text-xs text-[var(--text)] shadow-2xl hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            ▶ RELIVE TODAY
          </button>
        </div>
      )}
      <p className="pointer-events-none absolute bottom-0 left-0 right-0 min-h-[1.2em] bg-gradient-to-t from-black/70 to-transparent px-4 py-2 text-center text-xs text-[var(--muted)]">
        {currentDecision?.commit
          ? currentBoss
            ? `Decision #${current}: ${currentDecision.commit.side} attempt on ${tokenName(currentDecision.commit.token)} — battling ${currentBoss.icon} ${currentBoss.name}`
            : `Decision #${current}: ${currentDecision.commit.side} on ${tokenName(currentDecision.commit.token)} — allowed, no boss here`
          : started
            ? "Walking home."
            : "Exploring near home."}
      </p>
    </div>
  );
}
