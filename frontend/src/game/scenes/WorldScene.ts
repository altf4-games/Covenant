import Phaser from "phaser";
import { PLATFORM_LABEL } from "../../data/liquidity";
import type { Decision } from "../../lib/covenant";
import {
  TILE,
  WORLD_COLS,
  WORLD_ROWS,
  ROAD_A_ROW,
  WASTELAND,
  HOME_STAND,
  UNKNOWN_STAND,
  UNKNOWN_SIGN,
  MYSTERY_LABEL,
  HERO_FRAME,
  buildings,
  walkableTiles,
  roofTop,
  doorCol,
  standSpot,
  buildQuest,
  type Building,
  type QuestStep,
  type Spot,
} from "../logic";

const W = WORLD_COLS * TILE;
const H = WORLD_ROWS * TILE;
const PIXEL_FONT = "'Press Start 2P', monospace";
/** Forest drawn around the town so any screen shape shows trees, not black bars. */
const MARGIN = 60 * TILE;

// Frames in Kenney's Tiny Town sheet (frame N = tile_N.png).
const F = {
  grass: 0,
  grassTufts: 1,
  flowers: 2,
  pine: 4,
  bush: 5,
  roundTree: 16,
  deadPine: 3,
  mushrooms: 29,
  forest: 19,
  forestTopEdge: 7,
  forestBottomEdge: 31,
  forestLeftEdge: 18,
  forestRightEdge: 20,
  dirt: 40,
  dirtSpeck: 41,
  patchTopLeft: 12,
  patchTop: 13,
  patchLeft: 24,
  stones: 43,
  fenceL: 80,
  fenceM: 81,
  fenceR: 82,
  sign: 83,
  beehive: 94,
  well: 104,
  log: 106,
} as const;

const ROOF = {
  red: { top: [52, 53, 54], chimney: 55, bottom: [64, 65, 66], gable: 67 },
  blue: { top: [48, 49, 50], chimney: 51, bottom: [60, 61, 62], gable: 63 },
};
const WALL = {
  wood: { l: 72, m: 73, r: 75, window: 84, door: 85 },
  stone: { l: 76, m: 77, r: 79, window: 88, door: 89, empty: 78 },
};

export type StepListener = (step: QuestStep | null) => void;
export type ResultListener = (decisionId: string, won: boolean) => void;

const tileCenter = (col: number, row: number) => ({ x: col * TILE + TILE / 2, y: row * TILE + TILE / 2 });

export class WorldScene extends Phaser.Scene {
  private hero!: Phaser.GameObjects.Sprite;
  private heroTag!: Phaser.GameObjects.Container;
  private heroSpot: Spot = HOME_STAND;
  private battleLayer!: Phaser.GameObjects.Container;
  private questQueue: QuestStep[] = [];
  private playing = false;
  private onStep: StepListener = () => {};
  private onResult: ResultListener = () => {};
  private destroyed = false;
  private texts: Phaser.GameObjects.Text[] = [];
  private textRes = 2;
  private rightInset = 0;
  private insetTween?: Phaser.Tweens.Tween;
  private stamps = new Map<string, Phaser.GameObjects.Container>();
  private advanceDialog: (() => void) | null = null;

  constructor() {
    super("world");
  }

  preload() {
    this.load.spritesheet("town", "/game/kenney-tiny-town.png", { frameWidth: 16, frameHeight: 16 });
    this.load.spritesheet("dungeon", "/game/kenney-tiny-dungeon.png", { frameWidth: 16, frameHeight: 16 });
  }

  create() {
    this.events.once(Phaser.Scenes.Events.DESTROY, () => {
      this.destroyed = true;
    });

    this.drawForest();
    this.drawGround();
    this.drawPaths();
    this.drawDecor();
    for (const b of buildings()) this.drawBuilding(b);
    this.drawZoneBanners();

    const start = tileCenter(HOME_STAND.col, HOME_STAND.row);
    this.hero = this.add.sprite(start.x, start.y, "dungeon", HERO_FRAME).setDepth(20);
    this.heroTag = this.plate(0, 0, "AGENT", { size: 5, bg: 0x1d4ed8, fg: "#ffffff" }).setDepth(21);

    this.battleLayer = this.add.container(0, 0).setDepth(100).setVisible(false);

    this.input.on("pointerdown", () => this.advanceDialog?.());
    this.input.keyboard?.on("keydown-SPACE", () => this.advanceDialog?.());
    this.input.keyboard?.on("keydown-ENTER", () => this.advanceDialog?.());

    this.scale.on(Phaser.Scale.Events.RESIZE, () => this.fitCamera());
    this.fitCamera();

    this.time.addEvent({ delay: 3200, loop: true, callback: () => this.wander() });
  }

  update() {
    this.heroTag.setPosition(this.hero.x, this.hero.y - 13);
    this.heroTag.setVisible(this.hero.visible);
  }

  // -------------------------------------------------------------------------
  // Public API (called from React)

  public setOnStep(cb: StepListener) {
    this.onStep = cb;
  }

  public setOnResult(cb: ResultListener) {
    this.onResult = cb;
  }

  /** Device pixels on the right hidden behind the menu panel - the town recenters into the space left over. */
  public setRightInset(px: number) {
    if (this.destroyed) return;
    this.insetTween?.stop();
    const proxy = { v: this.rightInset };
    this.insetTween = this.tweens.add({
      targets: proxy,
      v: px,
      duration: 250,
      ease: "Sine.easeOut",
      onUpdate: () => {
        this.rightInset = proxy.v;
        this.fitCamera();
      },
    });
  }

  public playDecisions(decisions: Decision[]) {
    this.tweens.killTweensOf(this.hero);
    const at = tileCenter(this.heroSpot.col, this.heroSpot.row);
    this.hero.setPosition(at.x, at.y).setScale(1);
    for (const s of this.stamps.values()) s.destroy();
    this.stamps.clear();
    this.questQueue = buildQuest(decisions, this.heroSpot);
    this.playing = true;
    this.advance();
  }

  // -------------------------------------------------------------------------
  // Camera and crisp text

  private fitCamera() {
    if (this.destroyed) return;
    const gw = this.scale.gameSize.width;
    const gh = this.scale.gameSize.height;
    const availW = Math.max(200, gw - this.rightInset);
    const z = Math.min(availW / W, gh / H) * 0.97;
    const cam = this.cameras.main;
    cam.setZoom(z);
    cam.centerOn(W / 2 + this.rightInset / 2 / z, H / 2);
    // Text is rasterized once at its own resolution, then scaled by the
    // camera. Rendering it at the camera's zoom keeps it pin-sharp at any
    // screen size - the "blurry boss names" were small text textures
    // upscaled 3-6x.
    const res = Math.max(1, Math.min(8, Math.ceil(z)));
    if (res !== this.textRes) {
      this.textRes = res;
      this.texts = this.texts.filter((t) => t.active);
      for (const t of this.texts) t.setResolution(res);
    }
  }

  private text(x: number, y: number, str: string, style: Phaser.Types.GameObjects.Text.TextStyle) {
    const t = this.add.text(x, y, str, style).setResolution(this.textRes);
    this.texts.push(t);
    return t;
  }

  /** A readable name plate: rounded dark box behind pixel-font text. */
  private plate(
    x: number,
    y: number,
    line1: string,
    opts: { size?: number; bg?: number; fg?: string; line2?: string; line2Color?: string } = {},
  ) {
    const size = opts.size ?? 6;
    const t1 = this.text(0, 0, line1, { fontFamily: PIXEL_FONT, fontSize: `${size}px`, color: opts.fg ?? "#ffffff" }).setOrigin(0.5, 0);
    const parts: Phaser.GameObjects.GameObject[] = [];
    let h = size + 4;
    let w = t1.width;
    let t2: Phaser.GameObjects.Text | undefined;
    if (opts.line2) {
      t2 = this.text(0, size + 2, opts.line2, {
        fontFamily: PIXEL_FONT,
        fontSize: `${Math.max(4, size - 1)}px`,
        color: opts.line2Color ?? "#a7f3a0",
      }).setOrigin(0.5, 0);
      h += size + 1;
      w = Math.max(w, t2.width);
    }
    const bg = this.add.graphics();
    bg.fillStyle(opts.bg ?? 0x111827, 0.85);
    bg.fillRoundedRect(-w / 2 - 3, -2, w + 6, h, 2);
    t1.setY(0);
    parts.push(bg, t1);
    if (t2) parts.push(t2);
    const c = this.add.container(x, y - h / 2 + 1, parts);
    return c;
  }

  // -------------------------------------------------------------------------
  // The town

  private drawForest() {
    this.add.tileSprite(-MARGIN, -MARGIN, W + 2 * MARGIN, H + 2 * MARGIN, "town", F.grass).setOrigin(0).setDepth(-20);
    const block = (x: number, y: number, w: number, h: number) =>
      this.add.tileSprite(x, y, w, h, "town", F.forest).setOrigin(0).setDepth(-10);
    block(-MARGIN, -MARGIN, W + 2 * MARGIN, MARGIN - TILE);
    block(-MARGIN, H + TILE, W + 2 * MARGIN, MARGIN - TILE);
    block(-MARGIN, -TILE, MARGIN - TILE, H + 2 * TILE);
    block(W + TILE, -TILE, MARGIN - TILE, H + 2 * TILE);
    const edge = (col: number, row: number, frame: number) => {
      const p = tileCenter(col, row);
      this.add.image(p.x, p.y, "town", frame).setDepth(-10);
    };
    for (let c = -1; c <= WORLD_COLS; c++) {
      const corner = c === -1 || c === WORLD_COLS;
      edge(c, -1, corner ? F.forest : F.forestBottomEdge);
      edge(c, WORLD_ROWS, corner ? F.forest : F.forestTopEdge);
    }
    for (let r = 0; r < WORLD_ROWS; r++) {
      edge(-1, r, F.forestRightEdge);
      edge(WORLD_COLS, r, F.forestLeftEdge);
    }
  }

  private inWasteland(col: number, row: number) {
    return col >= WASTELAND.x && row >= WASTELAND.y;
  }

  private drawGround() {
    for (let row = 0; row < WORLD_ROWS; row++) {
      for (let col = 0; col < WORLD_COLS; col++) {
        let frame: number = (col * 7 + row * 13) % 11 === 0 ? F.grassTufts : F.grass;
        if (this.inWasteland(col, row)) {
          if (col === WASTELAND.x && row === WASTELAND.y) frame = F.patchTopLeft;
          else if (row === WASTELAND.y) frame = F.patchTop;
          else if (col === WASTELAND.x) frame = F.patchLeft;
          else frame = (col + row) % 5 === 0 ? F.dirtSpeck : F.dirt;
        }
        const p = tileCenter(col, row);
        this.add.image(p.x, p.y, "town", frame);
      }
    }
  }

  private drawPaths() {
    for (const k of walkableTiles()) {
      const [col, row] = k.split(",").map(Number);
      const p = tileCenter(col, row);
      this.add.image(p.x, p.y, "town", F.stones).setDepth(1);
    }
  }

  /** Tiles nothing decorative may sit on: buildings, their signs, roads. */
  private occupied(): Set<string> {
    const s = new Set(walkableTiles());
    for (const b of buildings()) {
      for (let r = roofTop(b) - 1; r < roofTop(b) + 3; r++) {
        for (let c = b.x - 1; c <= b.x + b.width; c++) s.add(`${c},${r}`);
      }
    }
    s.add(`${UNKNOWN_SIGN.col},${UNKNOWN_SIGN.row}`);
    return s;
  }

  private drawDecor() {
    const busy = this.occupied();
    const put = (col: number, row: number, frame: number, sheet = "town") => {
      if (busy.has(`${col},${row}`) || col < 0 || col >= WORLD_COLS || row < 0 || row >= WORLD_ROWS) return;
      busy.add(`${col},${row}`);
      const p = tileCenter(col, row);
      this.add.image(p.x, p.y, sheet, frame).setDepth(2);
    };

    // Tree line down the left edge, like the edge of a route.
    for (const r of [0, 2, 4, 8, 10, 12, 15, 17]) put(0, r, F.pine);
    // Hedges and flowers between the two streets.
    for (const c of [1, 6, 11, 17]) put(c, 7, F.bush);
    for (const c of [3, 4, 13, 14, 15]) put(c, 7, F.flowers);
    // Town square with a well.
    put(10, 15, F.well);
    for (const [c, r] of [[9, 15], [11, 15], [9, 16], [10, 16], [11, 16]]) put(c, r, F.flowers);
    for (const [c, r] of [[3, 15], [6, 16], [14, 15], [17, 16], [20, 15], [2, 17], [19, 17]]) put(c, r, F.roundTree);
    for (const [c, r] of [[5, 14], [15, 17], [12, 14]]) put(c, r, F.bush);
    // Ondo village: beehives behind a fence.
    put(31, 2, F.beehive);
    put(31, 4, F.beehive);
    put(25, 3, F.bush);
    put(24, 1, F.roundTree);
    put(24, 7, F.fenceL);
    for (let c = 25; c < 31; c++) put(c, 7, F.fenceM);
    put(31, 7, F.fenceR);
    // The wasteland: dead trees, logs, toadstools.
    for (const [c, r] of [[26, 10], [22, 16], [31, 9], [25, 16]]) put(c, r, F.deadPine);
    for (const [c, r] of [[23, 15], [28, 16]]) put(c, r, F.log);
    for (const [c, r] of [[24, 17], [29, 14], [27, 15]]) put(c, r, F.mushrooms);
    // A shop that isn't in town: where trades on unknown tokens get fought.
    put(UNKNOWN_SIGN.col, UNKNOWN_SIGN.row, F.sign);
    const s = tileCenter(UNKNOWN_SIGN.col, UNKNOWN_SIGN.row);
    this.plate(s.x - 10, s.y - 13, MYSTERY_LABEL, { size: 5, bg: 0x7f1d1d, line2: "NOT ALLOWED", line2Color: "#fecaca" }).setDepth(6);
  }

  private drawBuilding(b: Building) {
    const top = roofTop(b);
    const door = doorCol(b);
    const roof = ROOF[b.style.roof];
    const wall = WALL[b.style.wall];
    const put = (col: number, row: number, frame: number) => {
      const p = tileCenter(col, row);
      this.add.image(p.x, p.y, "town", frame).setDepth(3);
    };
    const last = b.x + b.width - 1;

    if (b.kind === "ruin") {
      // Walls with an empty doorway and only the roof's corners left.
      put(b.x, top + 1, roof.bottom[0]);
      put(last, top + 1, roof.bottom[2]);
      for (let c = b.x; c <= last; c++) {
        put(c, top + 2, c === b.x ? WALL.stone.l : c === last ? WALL.stone.r : c === door ? WALL.stone.empty : WALL.stone.m);
      }
    } else {
      for (let c = b.x; c <= last; c++) {
        const edge = c === b.x ? 0 : c === last ? 2 : 1;
        put(c, top, b.width >= 4 && c === b.x + 1 ? roof.chimney : roof.top[edge]);
        put(c, top + 1, c === door ? roof.gable : roof.bottom[edge]);
        const wallFrame =
          c === door ? wall.door : c === b.x ? wall.l : c === last ? wall.r : (c - b.x) % 2 === 1 ? wall.window : wall.m;
        put(c, top + 2, wallFrame);
      }
    }

    const cx = (b.x + b.width / 2) * TILE;
    const cy = (top - 1) * TILE + TILE / 2;
    if (b.kind === "home") {
      this.plate(cx, cy, b.label, { size: 6, bg: 0x1d4ed8 }).setDepth(6);
    } else if (b.kind === "ruin") {
      this.plate(cx, cy, b.label, { size: 6, bg: 0x44403c, line2: `${b.sublabel} CLOSED`, line2Color: "#fca5a5" }).setDepth(6);
    } else {
      this.plate(cx, cy, b.label, { size: 6, line2: b.sublabel }).setDepth(6);
    }
  }

  private drawZoneBanners() {
    const banner = (x: number, y: number, platform: keyof typeof PLATFORM_LABEL) => {
      const l = PLATFORM_LABEL[platform];
      this.plate(x, y, l.name, { size: 7, bg: 0x0f172a, fg: l.color, line2: l.blurb.toUpperCase(), line2Color: "#e5e7eb" }).setDepth(7);
    };
    banner(10.5 * TILE, 17.3 * TILE, "bstock");
    banner(28 * TILE, 0.55 * TILE, "ondo");
    banner(27 * TILE, 17.3 * TILE, "xstock");
  }

  // -------------------------------------------------------------------------
  // Walking

  private walk(points: { col: number; row: number }[], onDone: () => void) {
    const next = points.shift();
    if (!next || this.destroyed) {
      this.hero.setScale(1);
      onDone();
      return;
    }
    const to = tileCenter(next.col, next.row);
    const dist = Math.abs(to.x - this.hero.x) + Math.abs(to.y - this.hero.y);
    if (to.x !== this.hero.x) this.hero.setFlipX(to.x < this.hero.x);
    this.tweens.add({
      targets: this.hero,
      x: to.x,
      y: to.y,
      duration: Math.max(80, (dist / TILE) * 150),
      onUpdate: () => {
        if (!this.destroyed) this.hero.setScale(1, 1 + Math.abs(Math.sin(this.time.now / 70)) * 0.08);
      },
      onComplete: () => this.walk(points, onDone),
    });
  }

  /** While idle, stroll up and down the street outside home instead of standing frozen. */
  private wander() {
    if (this.destroyed || this.playing || this.tweens.isTweening(this.hero)) return;
    const target: Spot =
      Math.random() < 0.3 ? HOME_STAND : { col: Phaser.Math.Between(1, 6), row: ROAD_A_ROW, roadRow: ROAD_A_ROW };
    const from = this.heroSpot;
    this.heroSpot = target;
    const pts: { col: number; row: number }[] = [];
    if (from.row !== from.roadRow) pts.push({ col: from.col, row: from.roadRow });
    pts.push({ col: target.col, row: target.roadRow });
    if (target.row !== target.roadRow) pts.push({ col: target.col, row: target.row });
    this.walk(pts, () => {});
  }

  // -------------------------------------------------------------------------
  // The quest

  private advance() {
    if (this.destroyed) return;
    const step = this.questQueue.shift();
    if (!step) {
      this.playing = false;
      this.onStep(null);
      return;
    }
    this.onStep(step);

    if (step.kind === "walk") {
      const last = step.route[step.route.length - 1];
      this.walk([...step.route], () => {
        if (last) {
          const stand = [...buildings().map(standSpot), UNKNOWN_STAND].find((s) => s.col === last.col && s.row === last.row);
          if (stand) this.heroSpot = stand;
        }
        this.time.delayedCall(250, () => this.advance());
      });
      return;
    }

    this.playBattle(step);
  }

  private stampShop(won: boolean) {
    const k = `${this.heroSpot.col},${this.heroSpot.row}`;
    this.stamps.get(k)?.destroy();
    const p = tileCenter(this.heroSpot.col, this.heroSpot.row);
    // On the shop wall just left of the door - clear of the name sign above
    // the roof and of the MYSTERY lot's sign to its right.
    const badge = this.plate(p.x - 12, p.y - 10, won ? "OK" : "NO", { size: 6, bg: won ? 0x15803d : 0xb91c1c }).setDepth(8);
    this.stamps.set(k, badge);
    this.tweens.add({ targets: badge, scale: { from: 1.8, to: 1 }, duration: 300, ease: "Back.easeOut" });
  }

  /**
   * A Pokemon-style battle for every trade. The agent's opponent is the
   * safety rule being checked: a trade that follows every rule beats the
   * Rule Checker and goes through; a trade that breaks one loses to that
   * rule's monster and is blocked - which is the good outcome for the
   * money, and the dialogue says so. Click / Space / Enter skips ahead.
   */
  private playBattle(step: Extract<QuestStep, { kind: "battle" }>) {
    if (this.destroyed) return;
    const L = this.battleLayer;
    L.removeAll(true);
    L.setAlpha(1).setVisible(true);

    // Encounter flash, like the screen strobing before a wild battle.
    this.cameras.main.flash(120, 255, 255, 255);
    this.time.delayedCall(180, () => !this.destroyed && this.cameras.main.flash(120, 255, 255, 255));

    const g = this.add.graphics();
    g.fillStyle(0xf1f5e8, 1).fillRect(-MARGIN, -MARGIN, W + 2 * MARGIN, H + 2 * MARGIN);
    g.fillStyle(0xd9ecc4, 1).fillRect(-MARGIN, H * 0.5, W + 2 * MARGIN, MARGIN + H);
    g.fillStyle(0xa3d17f, 1).fillEllipse(W * 0.7, H * 0.42, 170, 40);
    g.lineStyle(2, 0x6aa150, 1).strokeEllipse(W * 0.7, H * 0.42, 170, 40);
    g.fillStyle(0xa3d17f, 1).fillEllipse(W * 0.28, H * 0.76, 190, 44);
    g.lineStyle(2, 0x6aa150, 1).strokeEllipse(W * 0.28, H * 0.76, 190, 44);

    const foeHome = { x: W * 0.7, y: H * 0.42 - 26 };
    const heroHome = { x: W * 0.28, y: H * 0.76 - 30 };
    const foe = this.add.sprite(W + 80, foeHome.y, "dungeon", step.foeFrame).setScale(4);
    const heroB = this.add.sprite(-80, heroHome.y, "dungeon", HERO_FRAME).setScale(4.5);

    const foeBox = this.hpBox(W * 0.05, H * 0.07, step.foeName);
    const heroBox = this.hpBox(W * 0.55, H * 0.55, "AGENT");

    const boxY = H * 0.8;
    const box = this.add.graphics();
    box.fillStyle(0xffffff, 1).fillRoundedRect(W * 0.02, boxY, W * 0.96, H * 0.18, 4);
    box.lineStyle(3, 0x334155, 1).strokeRoundedRect(W * 0.02, boxY, W * 0.96, H * 0.18, 4);
    const say = this.text(W * 0.05, boxY + 9, "", {
      fontFamily: PIXEL_FONT,
      fontSize: "8px",
      color: "#1f2937",
      lineSpacing: 6,
      wordWrap: { width: W * 0.9 },
    });
    const more = this.add.triangle(W * 0.95, H * 0.95, 0, 0, 8, 0, 4, 6, 0x334155).setVisible(false);
    const hint = this.text(W * 0.97, boxY - 3, "CLICK OR SPACE = NEXT", { fontFamily: PIXEL_FONT, fontSize: "5px", color: "#475569" }).setOrigin(1, 1);

    L.add([g, foe, heroB, foeBox.root, heroBox.root, box, say, more, hint]);

    this.tweens.add({ targets: foe, x: foeHome.x, duration: 450, ease: "Quad.easeOut" });
    this.tweens.add({ targets: heroB, x: heroHome.x, duration: 450, ease: "Quad.easeOut" });
    const bob = this.tweens.add({ targets: foe, y: foeHome.y - 4, duration: 520, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });

    const hit = (target: Phaser.GameObjects.Sprite, dir: 1 | -1) => {
      const x0 = target.x;
      this.tweens.add({
        targets: target,
        x: x0 + 18 * dir,
        duration: 140,
        yoyo: true,
        ease: "Quad.easeOut",
        onYoyo: () => {
          if (this.destroyed) return;
          this.cameras.main.shake(120, 0.004);
          const victim = target === heroB ? foe : heroB;
          victim.setTintFill(0xffffff);
          this.time.delayedCall(90, () => !this.destroyed && victim.clearTint());
        },
      });
    };
    const faint = (target: Phaser.GameObjects.Sprite) => {
      if (target === foe) bob.stop();
      this.tweens.add({ targets: target, y: target.y + 30, alpha: 0, duration: 450, ease: "Quad.easeIn" });
    };

    const lines = [...step.lines];
    const playLine = () => {
      if (this.destroyed) return;
      const line = lines.shift();
      if (!line) {
        this.advanceDialog = null;
        this.showResult(step.won, () => endBattle());
        return;
      }
      switch (line.cue) {
        case "heroAttack":
          hit(heroB, 1);
          foeBox.setHp(step.won ? 0 : 0.7);
          break;
        case "foeAttack":
          hit(foe, -1);
          heroBox.setHp(0);
          break;
        case "heroFaint":
          faint(heroB);
          break;
        case "foeFaint":
          faint(foe);
          break;
      }
      this.typeLine(say, more, line.text, playLine);
    };

    const endBattle = () => {
      if (this.destroyed) return;
      this.tweens.add({
        targets: L,
        alpha: 0,
        duration: 300,
        onComplete: () => {
          if (this.destroyed) return;
          L.setVisible(false);
          this.stampShop(step.won);
          this.onResult(step.decisionId, step.won);
          this.time.delayedCall(400, () => this.advance());
        },
      });
    };

    this.time.delayedCall(500, playLine);
  }

  /** Types a line out; the first skip finishes the line, the next moves on. Auto-advances after a pause long enough to read. */
  private typeLine(say: Phaser.GameObjects.Text, more: Phaser.GameObjects.Triangle, full: string, next: () => void) {
    let i = 0;
    let done = false;
    let wait: Phaser.Time.TimerEvent | undefined;
    more.setVisible(false);
    const finish = () => {
      if (done) return;
      done = true;
      typer.remove();
      say.setText(full);
      more.setVisible(true);
      wait = this.time.delayedCall(Math.max(1400, full.length * 35), go);
    };
    const go = () => {
      wait?.remove();
      this.advanceDialog = null;
      next();
    };
    const typer = this.time.addEvent({
      delay: 22,
      repeat: full.length - 1,
      callback: () => {
        if (this.destroyed) return;
        i++;
        say.setText(full.slice(0, i));
        if (i >= full.length) finish();
      },
    });
    this.advanceDialog = () => (done ? go() : finish());
  }

  private hpBox(x: number, y: number, name: string) {
    const w = W * 0.4;
    const bg = this.add.graphics();
    bg.fillStyle(0xfffbeb, 1).fillRoundedRect(0, 0, w, 30, 4);
    bg.lineStyle(2, 0x334155, 1).strokeRoundedRect(0, 0, w, 30, 4);
    const label = this.text(6, 5, name, { fontFamily: PIXEL_FONT, fontSize: "7px", color: "#1f2937" });
    const hpText = this.text(6, 18, "HP", { fontFamily: PIXEL_FONT, fontSize: "5px", color: "#b45309" });
    const barX = 22;
    const barW = w - barX - 8;
    const bar = this.add.graphics();
    const state = { hp: 1 };
    const draw = () => {
      bar.clear();
      bar.fillStyle(0x374151, 1).fillRoundedRect(barX, 17, barW, 7, 2);
      const color = state.hp > 0.5 ? 0x22c55e : state.hp > 0.2 ? 0xeab308 : 0xef4444;
      if (state.hp > 0) bar.fillStyle(color, 1).fillRoundedRect(barX + 1, 18, (barW - 2) * state.hp, 5, 2);
    };
    draw();
    const root = this.add.container(x, y, [bg, label, hpText, bar]);
    return {
      root,
      setHp: (to: number) => {
        this.tweens.add({ targets: state, hp: to, duration: 600, ease: "Sine.easeInOut", onUpdate: draw });
      },
    };
  }

  private showResult(won: boolean, onDone: () => void) {
    const title = won ? "TRADE ALLOWED!" : "TRADE BLOCKED!";
    const sub = won ? "IT FOLLOWED THE RULES" : "YOUR MONEY IS SAFE";
    const dim = this.add.rectangle(W / 2, H / 2, W + 2 * MARGIN, H + 2 * MARGIN, 0x000000, 0.5).setDepth(150);
    const banner = this.plate(W / 2, H * 0.45, title, {
      size: 14,
      bg: won ? 0x15803d : 0xb91c1c,
      line2: sub,
      line2Color: "#ffffff",
    }).setDepth(151);
    this.tweens.add({ targets: banner, scale: { from: 0.2, to: 1 }, duration: 350, ease: "Back.easeOut" });
    this.time.delayedCall(1700, () => {
      dim.destroy();
      banner.destroy();
      if (!this.destroyed) onDone();
    });
  }
}
