import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import { WorldScene } from "../game/scenes/WorldScene";
import { HERO_FRAME, RULE_CHECKER_FRAME, MONSTER, type QuestStep } from "../game/logic";
import type { Decision } from "../lib/covenant";
import { Sprite } from "./Sprite";

interface GameCanvasProps {
  decisions: Decision[];
  /** CSS px on the right covered by the menu panel; the town recenters into what's left. */
  rightInset: number;
  /** Called when the player starts the replay (not on load). */
  onStart?: () => void;
}

const QUEST_START_DELAY_MS = 700;
const FONT_WAIT_MS = 2500;

/**
 * The game: Phaser 3 with Kenney's CC0 Tiny Town / Tiny Dungeon art. The
 * canvas is rendered at the screen's real device resolution (not a small
 * canvas stretched with CSS), so pixel art and text both stay sharp at any
 * size; WorldScene's camera fits the town to whatever shape the window is.
 */
export function GameCanvas({ decisions, rightInset, onStart }: GameCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<WorldScene | null>(null);
  const [step, setStep] = useState<QuestStep | null>(null);
  const [place, setPlace] = useState<string>("");
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const [score, setScore] = useState({ allowed: 0, blocked: 0 });

  const trades = decisions.filter((d) => d.commit).length;

  useEffect(() => {
    let cancelled = false;
    let game: Phaser.Game | null = null;
    let observer: ResizeObserver | null = null;

    (async () => {
      // Draw the town's signs in the pixel font from the first frame, not a
      // fallback font that never gets redrawn.
      await Promise.race([
        document.fonts.load("8px 'Press Start 2P'").catch(() => undefined),
        new Promise((r) => setTimeout(r, FONT_WAIT_MS)),
      ]);
      const el = containerRef.current;
      if (cancelled || !el) return;
      const dpr = window.devicePixelRatio || 1;
      game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: el,
        backgroundColor: "#2f6b33",
        scene: [WorldScene],
        render: { pixelArt: true, antialias: false, roundPixels: true },
        scale: {
          mode: Phaser.Scale.NONE,
          width: Math.max(1, el.clientWidth * dpr),
          height: Math.max(1, el.clientHeight * dpr),
          zoom: 1 / dpr,
        },
      });
      observer = new ResizeObserver(() => {
        const d = window.devicePixelRatio || 1;
        game?.scale.resize(Math.max(1, el.clientWidth * d), Math.max(1, el.clientHeight * d));
      });
      observer.observe(el);

      // The scene object only exists after boot (READY), and its create()
      // - which builds the hero and the town - runs after the sprite
      // sheets finish loading, so wait for the scene's own CREATE too.
      game.events.once(Phaser.Core.Events.READY, () => {
        const scene = game!.scene.getScene("world") as WorldScene;
        const onCreated = () => {
          sceneRef.current = scene;
          scene.setOnStep((s) => {
            setStep(s);
            if (s?.kind === "walk") setPlace(s.placeLabel);
            if (s === null) setFinished(true);
          });
          scene.setOnResult((_id, won) =>
            setScore((sc) => (won ? { ...sc, allowed: sc.allowed + 1 } : { ...sc, blocked: sc.blocked + 1 })),
          );
          setReady(true);
        };
        if (scene.sys.settings.status >= Phaser.Scenes.RUNNING) onCreated();
        else scene.events.once(Phaser.Scenes.Events.CREATE, onCreated);
      });
    })();

    return () => {
      cancelled = true;
      observer?.disconnect();
      game?.destroy(true);
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (ready) sceneRef.current?.setRightInset(rightInset * (window.devicePixelRatio || 1));
  }, [ready, rightInset]);

  function start() {
    setStarted(true);
    setFinished(false);
    setScore({ allowed: 0, blocked: 0 });
    onStart?.();
    setTimeout(() => sceneRef.current?.playDecisions(decisions), QUEST_START_DELAY_MS);
  }

  // Numbered by the decision's own place in the day (oldest first), not by
  // the running score - the score ticks up at the end of a battle, before
  // the next step starts, which briefly showed "Trade 5 of 4".
  const order = decisions.filter((d) => d.commit).map((d) => d.id).reverse();
  const n = step?.decisionId ? order.indexOf(step.decisionId) + 1 : 0;
  let status = "Your agent is waiting at home.";
  if (started && step?.kind === "walk") {
    status = step.decisionId === null ? "All done! Walking home." : `Trade ${n} of ${trades}: walking to the ${place} shop…`;
  } else if (started && step?.kind === "battle") {
    status = `Trade ${n} of ${trades}: safety check at the ${place} shop!`;
  } else if (finished) {
    status = `Day complete: ${score.allowed} allowed, ${score.blocked} blocked.`;
  }

  return (
    <div className="absolute inset-0 overflow-hidden bg-[#2f6b33]">
      <div ref={containerRef} className="absolute inset-0" />

      {!ready && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-[var(--bg)]">
          <Sprite sheet="dungeon" frame={HERO_FRAME} size={48} />
          <p className="font-pixel text-[10px] tracking-widest text-[var(--muted)]">LOADING TOWN…</p>
        </div>
      )}

      {ready && started && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-3 rounded-lg border-2 border-slate-800 bg-white/95 px-3 py-2 text-slate-800 shadow-lg">
          <span className="font-pixel text-[10px] text-green-700">✓ ALLOWED {score.allowed}</span>
          <span className="font-pixel text-[10px] text-red-700">✋ BLOCKED {score.blocked}</span>
        </div>
      )}

      {ready && (!started || finished) && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/45 p-4" style={{ paddingRight: rightInset + 16 }}>
          <div className="w-full max-w-md rounded-xl border-4 border-slate-800 bg-white p-5 text-slate-800 shadow-2xl">
            <h2 className="font-pixel mb-4 text-center text-sm">{finished ? "DAY COMPLETE!" : "HOW IT WORKS"}</h2>
            {finished ? (
              <p className="mb-4 text-center text-sm">
                The agent tried <b>{trades}</b> trades in this replay. <b className="text-green-700">{score.allowed} followed the rules</b> and went ahead.{" "}
                <b className="text-red-700">{score.blocked} broke a rule</b> and were blocked, so that money stayed safe.
              </p>
            ) : (
              <ul className="mb-4 space-y-3 text-sm">
                <li className="flex items-center gap-3">
                  <Sprite sheet="dungeon" frame={HERO_FRAME} />
                  <span>
                    This is your <b>AGENT</b>. It buys and sells stocks for you.
                  </span>
                </li>
                <li className="flex items-center gap-3">
                  <Sprite sheet="town" frame={63} />
                  <span>
                    Each house is a <b>SHOP</b> for one stock. Bigger house = more money traded there.
                  </span>
                </li>
                <li className="flex items-center gap-3">
                  <Sprite sheet="dungeon" frame={RULE_CHECKER_FRAME} />
                  <span>
                    Before every trade, the agent must battle the <b>SAFETY RULES</b>. Follows the rules?{" "}
                    <b className="text-green-700">Agent wins, trade happens.</b>
                  </span>
                </li>
                <li className="flex items-center gap-3">
                  <Sprite sheet="dungeon" frame={MONSTER.NotionalExceeded.frame} />
                  <span>
                    Breaks a rule? A <b>RULE MONSTER</b> wins and the trade is{" "}
                    <b className="text-red-700">BLOCKED. Your money stays safe.</b>
                  </span>
                </li>
              </ul>
            )}
            <button
              onClick={start}
              disabled={trades === 0}
              className="font-pixel w-full rounded-lg border-4 border-slate-800 bg-yellow-300 px-4 py-3 text-xs text-slate-900 shadow-[0_4px_0_#1e293b] transition hover:bg-yellow-200 active:translate-y-1 active:shadow-none disabled:opacity-50"
            >
              {trades === 0 ? "NO TRADES FOUND" : finished ? "▶ WATCH AGAIN" : `▶ WATCH THE ${trades} TRADES`}
            </button>
          </div>
        </div>
      )}

      <p
        className="font-pixel pointer-events-none absolute bottom-0 left-0 z-10 bg-gradient-to-t from-black/80 to-transparent px-4 pb-3 pt-6 text-center text-[10px] leading-relaxed text-white"
        style={{ right: rightInset }}
      >
        {status}
      </p>
    </div>
  );
}
