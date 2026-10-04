// Retain the old entry point, but use the deterministic multi-car audit. The
// former real-time test had the drift direction backwards and depended on FPS.
await import('./physics-visual-audit.mjs');
