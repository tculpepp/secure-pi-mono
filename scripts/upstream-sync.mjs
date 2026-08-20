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
 *   sync     - replay the fork's merge + verify pipeline against the new tag,
 *              aborting instead of auto-resolving anything touching
 *              packages/coding-agent/SECURITY-SURFACE.md. Implemented.
 *   finalize - push the sync branch and write a report. Not implemented yet (PI-23).
 *
 * Deviation from the original Part 2 plan (documented on PI-22): the plan's step 3
 * called for `node scripts/rename-scope.mjs ... revert --apply` before merging, then
 * reapplying the fork's @tculpepp/spi-* rename after. That script was never built —
 * Part 1's actual v0.84.2 sync (PR #2) merged with the fork's naming intact and fixed
 * up branding in a single follow-up commit instead, and that worked fine. `sync` here
 * follows the proven approach: merge directly, no revert/reapply pass. If a future
 * merge's conflicts turn out to be dominated by scope-name collisions, revisit.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const UPSTREAM_REMOTE_URL = "https://github.com/earendil-works/pi.git";
const STATE_FILE = "packages/coding-agent/.upstream-sync-state.json";
const SECURITY_SURFACE_FILE = "packages/coding-agent/SECURITY-SURFACE.md";
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
// Upstream tags are fetched under a private ref namespace rather than into refs/tags/*
// directly: this fork's own releases are versioned in lockstep with upstream (see
// CLAUDE.md), so an upstream tag name like v0.84.2 can collide with this fork's own
// release tag of the same name. Colliding would silently rewrite the fork's tag.
const UPSTREAM_TAG_REF_PREFIX = "refs/upstream-sync-tags";

function run(cmd, options = {}) {
	return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
}

function runCapture(cmd) {
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
	const output = runCapture(`git ls-remote --tags ${UPSTREAM_REMOTE_URL}`);
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

function assertCleanWorkingTree() {
	const status = runCapture("git status --porcelain");
	if (status.trim()) {
		throw new Error("Uncommitted changes detected. Commit or stash before running sync.\n" + status);
	}
}

function assertOnMain() {
	const branch = runCapture("git rev-parse --abbrev-ref HEAD").trim();
	if (branch !== "main") {
		throw new Error(`sync must be run from main (currently on "${branch}").`);
	}
}

/**
 * Extracts every backtick-wrapped path in the first column of SECURITY-SURFACE.md's
 * markdown tables — covers both the enforcement-files table and the frozen-packages
 * table, since a diff touching either is equally load-bearing for the abort rule.
 *
 * The two tables use different path conventions: the enforcement-files table writes
 * paths relative to packages/coding-agent (e.g. `src/main.ts`, since that's the
 * package the manifest itself lives in), while the frozen-packages table already
 * writes repo-root-relative paths (e.g. `packages/mom`). Normalize both to
 * repo-root-relative here — every path git commands need actually run against.
 */
function parseSecuritySurfacePaths() {
	const content = readFileSync(SECURITY_SURFACE_FILE, "utf-8");
	const paths = new Set();
	for (const line of content.split("\n")) {
		const match = /^\|\s*`([^`]+)`/.exec(line);
		if (!match) continue;
		const path = match[1];
		paths.add(path.startsWith("packages/") ? path : `packages/coding-agent/${path}`);
	}
	if (paths.size === 0) {
		throw new Error(`No paths parsed from ${SECURITY_SURFACE_FILE} — check its table format hasn't changed.`);
	}
	return [...paths];
}

function upstreamTagRef(tag) {
	return `${UPSTREAM_TAG_REF_PREFIX}/${tag}`;
}

function fetchUpstreamTag(tag) {
	const ref = upstreamTagRef(tag);
	console.log(`Fetching ${tag} from ${UPSTREAM_REMOTE_URL} into ${ref}...`);
	// --no-tags: without it, git auto-follows every reachable tag on the remote and writes
	// it straight into refs/tags/*, defeating the point of fetching into a private
	// namespace above (confirmed by testing — a plain fetch pulled 300+ upstream tags
	// into refs/tags/* despite the explicit refspec).
	run(`git fetch --no-tags ${UPSTREAM_REMOTE_URL} refs/tags/${tag}:${ref}`);
	return ref;
}

/** True if any of `paths` differ between the two refs — a conflict-free merge can still change these silently. */
function securitySurfaceChanged(fromRef, toRef, paths) {
	const existing = paths.filter((path) => {
		try {
			// stdio "ignore" on stderr: a miss here is an expected, not exceptional, case
			// (a security-surface file that didn't exist yet at fromRef) — the default
			// execSync behavior of inheriting stderr would otherwise print a "fatal:
			// path does not exist" line per miss, which reads as an error but isn't one.
			execSync(`git cat-file -e ${fromRef}:${path}`, { stdio: ["ignore", "ignore", "ignore"] });
			return true;
		} catch {
			return false;
		}
	});
	if (existing.length === 0) return false;
	const diffStat = runCapture(
		`git diff --stat ${fromRef}..${toRef} -- ${existing.map((path) => `'${path}'`).join(" ")}`,
	);
	return diffStat.trim().length > 0;
}

function sync(targetTag) {
	if (!targetTag || !parseTag(targetTag)) {
		throw new Error("Usage: node scripts/upstream-sync.mjs sync <vX.Y.Z>");
	}

	assertCleanWorkingTree();
	assertOnMain();

	const state = readState();
	const securityPaths = parseSecuritySurfacePaths();
	console.log(`Tracking ${securityPaths.length} security-surface paths from ${SECURITY_SURFACE_FILE}.`);

	const fromRef = fetchUpstreamTag(state.lastSyncedTag);
	const toRef = fetchUpstreamTag(targetTag);

	console.log(`Checking security-surface paths for changes between ${state.lastSyncedTag} and ${targetTag}...`);
	if (securitySurfaceChanged(fromRef, toRef, securityPaths)) {
		console.error("ABORT: upstream changed one or more security-surface paths between these tags.");
		console.error(
			`Run manually: git diff --stat ${fromRef}..${toRef} -- ${securityPaths.map((p) => `'${p}'`).join(" ")}`,
		);
		console.error("Not attempting an automated merge. This requires human review — see SECURITY-SURFACE.md.");
		process.exit(1);
	}
	console.log("No security-surface path changes detected upstream. Proceeding.");

	const branchName = `sync/upstream-${targetTag}`;
	console.log(`Creating branch ${branchName}...`);
	run(`git checkout -b ${branchName}`);

	console.log(`Merging ${toRef} (${targetTag})...`);
	try {
		run(`git merge --no-ff --no-commit ${toRef}`);
	} catch {
		const conflicted = runCapture("git diff --name-only --diff-filter=U")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const conflictedSecurityFiles = conflicted.filter((file) => securityPaths.includes(file));
		console.error(`\nABORT: merge produced conflicts on ${conflicted.length} file(s).`);
		if (conflictedSecurityFiles.length > 0) {
			console.error(`SECURITY-SURFACE.md files among them: ${conflictedSecurityFiles.join(", ")}`);
			console.error("Never auto-resolving these, even partially. Leaving the merge in progress for human review.");
		} else {
			console.error("None of the conflicts are security-surface files, but this script does not auto-resolve");
			console.error("any conflicts. Leaving the merge in progress for human review.");
		}
		console.error(`Conflicted files:\n${conflicted.map((f) => `  ${f}`).join("\n")}`);
		process.exit(1);
	}

	console.log("Merge is conflict-free. Running checks...");
	try {
		run("npm run check");
		run("./test.sh");
	} catch {
		console.error("\nABORT: post-merge checks failed. Leaving the merge committed-but-unfinalized on this branch");
		console.error("for human review — not updating the sync state file.");
		process.exit(1);
	}

	console.log("Checks passed. Committing merge and updating sync state...");
	run(`git commit --no-edit`);

	const newState = {
		lastSyncedTag: targetTag,
		lastSyncedAt: new Date().toISOString(),
		lastSyncCommit: runCapture("git rev-parse HEAD").trim(),
	};
	writeFileSync(STATE_FILE, `${JSON.stringify(newState, null, "\t")}\n`);
	run(`git add ${STATE_FILE}`);
	run(`git commit -m "chore: update upstream-sync state to ${targetTag}"`);

	console.log(`\nSync to ${targetTag} complete on branch ${branchName}. Not pushed — that's the finalize step.`);
}

const subcommand = process.argv[2];

if (subcommand === "check") {
	check();
} else if (subcommand === "sync") {
	sync(process.argv[3]);
} else {
	console.error("Usage: node scripts/upstream-sync.mjs <check|sync> [args]");
	console.error(`Unknown or unimplemented subcommand: ${subcommand ?? "(none)"}`);
	process.exit(1);
}
