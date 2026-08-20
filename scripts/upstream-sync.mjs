#!/usr/bin/env node
/**
 * Upstream sync automation for secure-pi-mono.
 *
 * Usage:
 *   node scripts/upstream-sync.mjs check
 *
 * Subcommands (planned, not all implemented yet):
 *   check    - compare the latest upstream release tag against the checked-in state
 *              file and report whether a sync is due. Implemented.
 *   sync     - replay the fork's rename + merge + verify pipeline against the new
 *              tag, aborting instead of auto-resolving anything touching
 *              packages/coding-agent/SECURITY-SURFACE.md. Not implemented yet (PI-22).
 *   finalize - push the sync branch and write a report. Not implemented yet (PI-23).
 */

import { appendFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const UPSTREAM_REMOTE_URL = "https://github.com/earendil-works/pi.git";
const STATE_FILE = "packages/coding-agent/.upstream-sync-state.json";
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

function run(cmd) {
	return execSync(cmd, { encoding: "utf-8" });
}

function readState() {
	return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

function compareVersions(a, b) {
	for (let i = 0; i < 3; i++) {
		const diff = a[i] - b[i];
		if (diff !== 0) return diff;
	}
	return 0;
}

function parseTag(tag) {
	const match = TAG_RE.exec(tag);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Lists real release tags from upstream, newest first. Filters out non-semver
 * refs and the `^{}` peeled-annotation duplicates `git ls-remote` emits for
 * annotated tags (same tag name, different object — we only want the tag ref).
 */
function listUpstreamTags() {
	const output = run(`git ls-remote --tags ${UPSTREAM_REMOTE_URL}`);
	const tags = [];
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [, ref] = trimmed.split("\t");
		if (!ref || ref.endsWith("^{}")) continue;
		const tag = ref.replace("refs/tags/", "");
		const parsed = parseTag(tag);
		if (parsed) tags.push({ tag, parsed });
	}
	tags.sort((a, b) => compareVersions(b.parsed, a.parsed));
	return tags;
}

function writeGithubOutput(entries) {
	const outputFile = process.env.GITHUB_OUTPUT;
	if (!outputFile) {
		for (const [key, value] of Object.entries(entries)) {
			console.log(`  (no GITHUB_OUTPUT set — would write) ${key}=${value}`);
		}
		return;
	}
	for (const [key, value] of Object.entries(entries)) {
		appendFileSync(outputFile, `${key}=${value}\n`);
	}
}

function check() {
	const state = readState();
	const currentParsed = parseTag(state.lastSyncedTag);
	if (!currentParsed) {
		throw new Error(`${STATE_FILE}: lastSyncedTag "${state.lastSyncedTag}" is not a valid vX.Y.Z tag`);
	}

	console.log(`Current synced tag: ${state.lastSyncedTag} (synced ${state.lastSyncedAt}, ${state.lastSyncCommit})`);
	console.log(`Checking ${UPSTREAM_REMOTE_URL} for newer release tags...`);

	const tags = listUpstreamTags();
	if (tags.length === 0) {
		throw new Error(`No valid vX.Y.Z release tags found on ${UPSTREAM_REMOTE_URL}`);
	}

	const latest = tags[0];
	const isNewer = compareVersions(latest.parsed, currentParsed) > 0;

	if (isNewer) {
		console.log(`New release available: ${latest.tag}`);
		writeGithubOutput({ new_release: "true", target_tag: latest.tag });
	} else {
		console.log(`Up to date. Latest upstream tag (${latest.tag}) is not newer than ${state.lastSyncedTag}.`);
		writeGithubOutput({ new_release: "false" });
	}
}

const subcommand = process.argv[2];

if (subcommand === "check") {
	check();
} else {
	console.error("Usage: node scripts/upstream-sync.mjs check");
	console.error(`Unknown or unimplemented subcommand: ${subcommand ?? "(none)"}`);
	process.exit(1);
}
