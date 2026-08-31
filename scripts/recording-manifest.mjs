import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { REQUIRED_SCENARIO_IDS } from './recording-timeline.mjs';

export async function loadRecordingManifest(manifestPath) {
  let source;
  try {
    source = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`RECORDING_MANIFEST_NOT_FOUND:${manifestPath}`);
    throw error;
  }

  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error(`RECORDING_MANIFEST_JSON_INVALID:${manifestPath}`);
  }

  const scenarioIds = Array.isArray(manifest?.clips)
    ? manifest.clips.map((clip) => clip?.scenarioId)
    : [];
  if (JSON.stringify(scenarioIds) !== JSON.stringify(REQUIRED_SCENARIO_IDS)) {
    throw new Error(`RECORDING_MANIFEST_SCENARIOS_INVALID:${scenarioIds.join(',')}`);
  }
  return manifest;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    const manifest = await loadRecordingManifest(process.argv[2]);
    process.stdout.write(JSON.stringify(manifest));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
