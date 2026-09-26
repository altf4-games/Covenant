import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// React Testing Library's auto-cleanup only registers itself when it
// detects a global `afterEach` (the Jest convention). This project imports
// describe/it/expect explicitly from "vitest" rather than enabling
// vitest's `globals: true`, so that detection never fires and DOM from one
// test leaks into the next - confirmed the hard way: TerritoryMap.test.tsx's
// crown-count assertion in a later test was silently passing against a
// leftover element from an earlier test's un-unmounted render.
afterEach(() => {
  cleanup();
});
