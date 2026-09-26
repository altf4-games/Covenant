import Phaser from "phaser";
import { TERRITORY_TOKENS, PLATFORM_LABEL, type Platform } from "../../data/liquidity";
import { WORLD_COLS, WORLD_ROWS, HOME_TILE, TILE, HEADER_HEIGHT, tokenTilePositions, type QuestStep } from "../logic";

const ZONE_OF_COL: Platform[] = (() => {
  const arr: Platform[] = [];
  for (let c = 0; c < WORLD_COLS; c++) {
    if (c < 12) arr.push("bstock");
    else if (c < 17) arr.push("ondo");
    else arr.push("xstock");
  }
  return arr;
})();

export type StepListener = (step: QuestStep | null) => void;

export class WorldScene extends Phaser.Scene {
  private hero!: Phaser.GameObjects.Sprite;
  private battleLayer!: Phaser.GameObjects.Container;
  private questQueue: QuestStep[] = [];
  private playing = false;
  private onStep: StepListener = () => {};
  private destroyed = false;

  constructor() {
    super("world");
  }

  preload() {
    this.load.image("hero", "/game/dungeon/hero.png");
    const bosses = [
      "boss_ghost", "boss_hood", "boss_golem", "boss_skeleton", "boss_purple",
      "boss_demon2", "boss_skeleton2", "boss_mummy", "boss_demon", "boss_goblin",
    ];
    for (const b of bosses) this.load.image(b, `/game/dungeon/${b}.png`);
    this.load.image("grass", "/game/town/grass.png");
    this.load.image("grass_flower", "/game/town/grass_flower.png");
    this.load.image("tree", "/game/town/tree.png");
    this.load.image("dirt", "/game/town/dirt.png");
    this.load.image("dirt2", "/game/town/dirt2.png");
    this.load.image("stone", "/game/town/stone.png");
    this.load.image("stone2", "/game/town/stone2.png");
  }

  create() {
    // Guards every tween/timer callback below - React StrictMode's dev-only
    // double-effect-invoke mounts, destroys, and remounts this scene almost
    // immediately, and Phaser's destroy() tears down GameObjects
    // synchronously. A callback queued by the first, soon-to-be-destroyed
    // instance can still fire after that.
    this.events.once(Phaser.Scenes.Events.DESTROY, () => {
      this.destroyed = true;
    });
    this.drawWorld();
    this.drawTokenMarkers();

    this.hero = this.add.sprite(this.tileX(HOME_TILE.col), this.tileY(HOME_TILE.row), "hero");
    this.hero.setScale(1.5);
    this.hero.setDepth(10);

    this.battleLayer = this.add.container(0, 0);
    this.battleLayer.setDepth(200);
    this.battleLayer.setVisible(false);
  }

  /** Called from React once real decisions load. Cancels any quest in flight. */
  public setOnStep(cb: StepListener) {
    this.onStep = cb;
  }

  public playQuest(quest: QuestStep[]) {
    this.questQueue = [...quest];
    if (!this.playing) this.advance();
  }

  private tileX(col: number) {
    return col * TILE + TILE / 2;
  }
  private tileY(row: number) {
    return row * TILE + TILE / 2 + HEADER_HEIGHT;
  }

  private drawWorld() {
    for (let row = 0; row < WORLD_ROWS; row++) {
      for (let col = 0; col < WORLD_COLS; col++) {
        const zone = ZONE_OF_COL[col];
        const key = this.floorTileFor(zone, row, col);
        const img = this.add.image(this.tileX(col), this.tileY(row), key);
        img.setScale(1.5);
      }
    }
    // Zone labels.
    let x = 0;
    for (const zone of ["bstock", "ondo", "xstock"] as Platform[]) {
      const cols = ZONE_OF_COL.filter((z) => z === zone).length;
      const label = PLATFORM_LABEL[zone];
      this.add.text(this.tileX(x) - TILE / 2, 12, label.name, {
        fontFamily: "ui-monospace, monospace",
        fontSize: "13px",
        color: label.color,
        fontStyle: "bold",
      });
      x += cols;
    }
  }

  private floorTileFor(zone: Platform, row: number, col: number): string {
    if (zone === "bstock") {
      if ((row + col) % 5 === 0) return "tree";
      if ((row * 3 + col) % 7 === 0) return "grass_flower";
      return "grass";
    }
    if (zone === "ondo") {
      return (row + col) % 3 === 0 ? "stone" : "dirt";
    }
    // xstock: barren, sparse - deliberately the least decorated floor.
    return (row + col) % 6 === 0 ? "stone2" : "dirt2";
  }

  private drawTokenMarkers() {
    const positions = tokenTilePositions();
    for (const token of TERRITORY_TOKENS) {
      const pos = positions.get(token.ticker);
      if (!pos) continue;
      // Radius capped well below half a tile so the marker never bleeds
      // into a neighboring tile regardless of how large a token's real
      // liquidity figure is.
      const r = Math.max(4, Math.min(TILE / 2 - 3, Math.sqrt(token.reservesUsd) / 60));
      const color = Phaser.Display.Color.HexStringToColor(PLATFORM_LABEL[token.platform].color).color;
      const circle = this.add.circle(this.tileX(pos.col), this.tileY(pos.row), r, color, 0.7);
      circle.setStrokeStyle(1, 0xffffff, 0.5);
      circle.setDepth(1);
      this.add
        .text(this.tileX(pos.col), this.tileY(pos.row) + TILE / 2 + 2, token.ticker, {
          fontFamily: "ui-monospace, monospace",
          fontSize: "9px",
          color: "#e6e9ee",
        })
        .setOrigin(0.5, 0)
        .setDepth(1);
    }
  }

  private advance() {
    if (this.destroyed) return;
    const step = this.questQueue.shift();
    if (!step) {
      this.playing = false;
      this.onStep(null);
      // Walk home.
      this.tweens.add({
        targets: this.hero,
        x: this.tileX(HOME_TILE.col),
        y: this.tileY(HOME_TILE.row),
        duration: 500,
      });
      return;
    }
    this.playing = true;
    this.onStep(step);

    if (step.kind === "walk") {
      this.tweens.add({
        targets: this.hero,
        x: this.tileX(step.toCol),
        y: this.tileY(step.toRow),
        duration: 700,
        ease: "Sine.easeInOut",
        onUpdate: () => {
          // Fake a walk cycle with a squash/stretch bob - the sprite has no
          // dedicated walk frames.
          if (this.destroyed) return;
          this.hero.setScale(1.5, 1.5 + Math.sin(this.time.now / 60) * 0.06);
        },
        onComplete: () => {
          if (this.destroyed) return;
          this.hero.setScale(1.5, 1.5);
          this.advance();
        },
      });
      return;
    }

    if (step.kind === "arrive") {
      const ring = this.add.circle(this.hero.x, this.hero.y, 4, 0x3ecf8e, 0.6);
      this.tweens.add({
        targets: ring,
        radius: 24,
        alpha: 0,
        duration: 500,
        onComplete: () => {
          if (this.destroyed) return;
          ring.destroy();
          this.advance();
        },
      });
      return;
    }

    // step.kind === "battle"
    this.playPokemonBattle(step);
  }

  /**
   * A Pokemon-style encounter screen, not a small in-place lunge: the
   * overworld is covered edge-to-edge, the boss stands on a platform at
   * upper right, the hero on one at lower left, and a dialogue box below
   * types out what actually happened on chain, one line at a time - "a wild
   * X appeared", then the real denial reason, then the outcome. A denial
   * never shows the boss losing (the mandate holding is the whole point),
   * so the hero's own attack always fails and the boss is what's still
   * standing at the end.
   */
  private playPokemonBattle(step: Extract<QuestStep, { kind: "battle" }>) {
    if (this.destroyed) return;
    // Defensive: ensure battleLayer exists even if create() somehow hasn't
    // run yet by the time this fires (see GameCanvas.tsx for why the real
    // fix is waiting on the scene's own CREATE event, not the game's
    // "ready" event).
    if (!this.battleLayer) {
      this.battleLayer = this.add.container(0, 0);
      this.battleLayer.setDepth(200);
    }
    this.battleLayer.removeAll(true);
    this.battleLayer.setVisible(true);

    const W = WORLD_COLS * TILE;
    const H = WORLD_ROWS * TILE + HEADER_HEIGHT;
    const heroHome = { x: this.hero.x, y: this.hero.y };

    // Screen transition: a quick flash + zoom punch reads as "encounter
    // started" without needing a spritesheet.
    this.cameras.main.flash(160, 255, 255, 255);
    this.hero.setVisible(false);

    const sky = this.add.rectangle(W / 2, H * 0.32, W, H * 0.64, 0x1c2b3a);
    const ground = this.add.rectangle(W / 2, H * 0.74, W, H * 0.52, 0x24331f);
    const bossPad = this.add.ellipse(W * 0.74, H * 0.42, 64, 22, 0x000000, 0.35);
    const heroPad = this.add.ellipse(W * 0.24, H * 0.66, 64, 22, 0x000000, 0.35);

    const boss = this.add.sprite(W * 0.74, H * 0.42 - 14, step.sprite).setScale(2.6);
    const heroBattler = this.add.sprite(W * 0.24, H * 0.66 - 14, "hero").setScale(2.6).setFlipX(true);

    const nameTag = this.add
      .rectangle(W * 0.74, H * 0.42 - 44, 96, 20, 0x0b0d10, 0.85)
      .setStrokeStyle(1, 0xe5484d, 0.7);
    const nameText = this.add
      .text(W * 0.74, H * 0.42 - 44, `${step.bossIcon} ${step.bossName}`, {
        fontFamily: "ui-monospace, monospace",
        fontSize: "9px",
        color: "#e6e9ee",
      })
      .setOrigin(0.5);

    const boxH = 56;
    const box = this.add.rectangle(W / 2, H - boxH / 2 - 4, W - 12, boxH, 0x0b0d10, 0.95).setStrokeStyle(2, 0xe6e9ee, 0.8);
    const boxText = this.add
      .text(16, H - boxH - 4 + 8, "", {
        fontFamily: "ui-monospace, monospace",
        fontSize: "11px",
        color: "#e6e9ee",
        wordWrap: { width: W - 32 },
      })
      .setOrigin(0, 0);
    const prompt = this.add
      .text(W - 18, H - 12, "▼", { fontFamily: "ui-monospace, monospace", fontSize: "11px", color: "#8b93a1" })
      .setOrigin(1, 1);
    prompt.setVisible(false);

    this.battleLayer.add([sky, ground, bossPad, heroPad, boss, heroBattler, nameTag, nameText, box, boxText, prompt]);

    // Idle bob for the boss - a wild encounter is never perfectly static.
    const bobTween = this.tweens.add({
      targets: boss,
      y: boss.y - 4,
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    const lines = [
      `A wild ${step.bossIcon} ${step.bossName} appeared!`,
      `The agent's order is DENIED — ${step.reason}.`,
      "The mandate held. No funds moved.",
    ];

    const typeLine = (text: string, onDone: () => void) => {
      if (this.destroyed) return;
      prompt.setVisible(false);
      boxText.setText("");
      let i = 0;
      const timer = this.time.addEvent({
        delay: 18,
        repeat: text.length - 1,
        callback: () => {
          if (this.destroyed) {
            timer.remove();
            return;
          }
          i++;
          boxText.setText(text.slice(0, i));
          if (i >= text.length) {
            prompt.setVisible(true);
            this.time.delayedCall(650, () => {
              if (!this.destroyed) onDone();
            });
          }
        },
      });
    };

    const playLine = (idx: number) => {
      if (this.destroyed) return;
      if (idx >= lines.length) {
        endBattle();
        return;
      }
      if (idx === 1) {
        // The hero's attempt lunges in and visibly fails as this line
        // types - a denial never shows the boss losing.
        this.tweens.add({
          targets: heroBattler,
          x: heroBattler.x + 14,
          duration: 180,
          yoyo: true,
          ease: "Quad.easeOut",
          onYoyo: () => {
            if (this.destroyed) return;
            this.cameras.main.shake(100, 0.003);
            boss.setTint(0xff8888);
            this.time.delayedCall(140, () => {
              if (!this.destroyed) boss.clearTint();
            });
          },
        });
      }
      typeLine(lines[idx], () => playLine(idx + 1));
    };

    const endBattle = () => {
      if (this.destroyed) return;
      bobTween.stop();
      this.tweens.add({
        targets: this.battleLayer,
        alpha: 0,
        duration: 300,
        onComplete: () => {
          if (this.destroyed) return;
          this.battleLayer.setVisible(false);
          this.battleLayer.setAlpha(1);
          this.hero.setVisible(true);
          this.hero.setPosition(heroHome.x, heroHome.y);
          this.advance();
        },
      });
    };

    playLine(0);
  }
}
