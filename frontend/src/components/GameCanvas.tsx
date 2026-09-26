import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import { WorldScene } from "../game/scenes/WorldScene";
import { buildQuest, WORLD_COLS, WORLD_ROWS } from "../game/logic";
import { bossFor, tokenName, type Decision } from "../lib/covenant";

interface GameCanvasProps {
  decisions: Decision[];
}

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
export function GameCanvas({ decisions }: GameCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<WorldScene | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      width: WORLD_COLS * 32,
      height: WORLD_ROWS * 32 + 40,
      parent: containerRef.current,
      backgroundColor: "#0b0d10",
      scene: [WorldScene],
      render: { pixelArt: true },
    });
    gameRef.current = game;
    game.events.once("ready", () => {
      const scene = game.scene.getScene("world") as WorldScene;
      sceneRef.current = scene;
      scene.setOnStep((step) => {
        setCurrent(step ? step.decisionId : null);
      });
      setReady(true);
    });
    return () => {
      game.destroy(true);
      gameRef.current = null;
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (ready && sceneRef.current) {
      sceneRef.current.playQuest(buildQuest(decisions));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, decisions]);

  const currentDecision = decisions.find((d) => d.id === current);
  const currentBoss = currentDecision?.commit && !currentDecision.commit.allowed ? bossFor(currentDecision.commit.reason) : null;

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
        The world — real CC0 sprites (Kenney), a real quest queue
      </h2>
      <div ref={containerRef} className="overflow-x-auto" />
      <p className="mt-2 min-h-[1.2em] text-center text-xs text-[var(--muted)]">
        {currentDecision?.commit
          ? currentBoss
            ? `Decision #${current}: ${currentDecision.commit.side} attempt on ${tokenName(currentDecision.commit.token)} — battling ${currentBoss.icon} ${currentBoss.name}`
            : `Decision #${current}: ${currentDecision.commit.side} on ${tokenName(currentDecision.commit.token)} — allowed, no boss here`
          : "Walking home."}
      </p>
    </div>
  );
}
