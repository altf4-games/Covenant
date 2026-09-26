import Phaser from "phaser";
import { TERRITORY_TOKENS, PLATFORM_LABEL, type Platform } from "../../data/liquidity";
import { WORLD_COLS, WORLD_ROWS, HOME_TILE, tokenTilePositions, type QuestStep } from "../logic";

const TILE = 24; // rendered size; source art is 16x16, scaled 1.5x - keeps the full 21-tile-wide world (504px) inside the panel without horizontal scroll on common viewport widths
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
    this.drawWorld();
    this.drawTokenMarkers();

    this.hero = this.add.sprite(this.tileX(HOME_TILE.col), this.tileY(HOME_TILE.row), "hero");
    this.hero.setScale(1.5);
    this.hero.setDepth(10);

    this.battleLayer = this.add.container(0, 0);
    this.battleLayer.setDepth(100);
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
    return row * TILE + TILE / 2 + 40; // leave room for a header
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
      const r = Math.max(4, Math.min(14, Math.sqrt(token.reservesUsd) / 60));
      const color = Phaser.Display.Color.HexStringToColor(PLATFORM_LABEL[token.platform].color).color;
      const circle = this.add.circle(this.tileX(pos.col), this.tileY(pos.row), r, color, 0.7);
      circle.setStrokeStyle(1, 0xffffff, 0.5);
      this.add
        .text(this.tileX(pos.col), this.tileY(pos.row) + r + 6, token.ticker, {
          fontFamily: "ui-monospace, monospace",
          fontSize: "9px",
          color: "#e6e9ee",
        })
        .setOrigin(0.5, 0);
    }
  }

  private advance() {
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
          this.hero.setScale(1.5, 1.5 + Math.sin(this.time.now / 60) * 0.06);
        },
        onComplete: () => this.advance(),
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
          ring.destroy();
          this.advance();
        },
      });
      return;
    }

    // step.kind === "battle"
    this.playBattle(step);
  }

  private playBattle(step: Extract<QuestStep, { kind: "battle" }>) {
    this.battleLayer.removeAll(true);
    this.battleLayer.setVisible(true);

    const cx = this.hero.x;
    const cy = this.hero.y;
    const panel = this.add.rectangle(cx, cy - 20, 120, 70, 0x0b0d10, 0.85).setStrokeStyle(1, 0xe5484d, 0.6);
    const boss = this.add.sprite(cx + 26, cy - 20, step.sprite).setScale(1.7);
    this.battleLayer.add([panel, boss]);

    // Hero lunges toward the boss, then bounces back - the agent's attempt
    // fails, the mandate holds. Matches the same non-negotiable narrative
    // rule the earlier React version used: a denial never shows the boss
    // losing.
    this.tweens.add({
      targets: this.hero,
      x: cx + 12,
      duration: 220,
      yoyo: true,
      ease: "Quad.easeOut",
      onYoyo: () => {
        this.cameras.main.shake(120, 0.004);
        boss.setTint(0xff8888);
        this.time.delayedCall(150, () => boss.clearTint());
      },
      onComplete: () => {
        this.time.delayedCall(500, () => {
          this.battleLayer.setVisible(false);
          this.advance();
        });
      },
    });
  }
}
