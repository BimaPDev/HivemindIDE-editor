/*---------------------------------------------------------------------------------------------
 *  HivemindIDE desktop-only feature registration.
 *
 *  The ONLY HivemindIDE file workbench.desktop.main.ts imports. Features that
 *  need the main process (spawning llama.cpp) register here so the browser
 *  entry point, which web builds also load, never pulls them in.
 *--------------------------------------------------------------------------------------------*/

// Proxy to the llama.cpp server manager in the main process.
import '../../../../platform/hivemindide/electron-browser/localLlamaService.js';

// Local GGUF models in the Chat panel: model picker vendor, default agent, workspace RAG, status bar.
import '../browser/localModels/localModels.contribution.js';
