import { appendFileSync, readFileSync } from 'node:fs';

export const CLOUD_REPOSITORY = 'metatheoryinc/kb-1-cloud';
export const DAEMON_REPOSITORY = 'metatheoryinc/kb-1-daemon';

const SHA_PATTERN = /^[0-9a-f]{40}$/;

function requireValue(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${name} is required`);
  }
  return String(value);
}

function requireSha(value, name) {
  const sha = requireValue(value, name).toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${name} must be a full lowercase 40-character SHA`);
  }
  return sha;
}

function requirePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function buildDispatchPayload(pull) {
  if (!pull || typeof pull !== 'object') {
    throw new Error('pull request payload must be an object');
  }
  if (pull.state !== 'closed' || !pull.merged_at) {
    throw new Error('daemon pull request must be merged');
  }
  if (pull.base?.ref !== 'main') {
    throw new Error(`daemon pull request must target main, received: ${pull.base?.ref}`);
  }
  if (pull.base?.repo?.full_name !== DAEMON_REPOSITORY) {
    throw new Error(`unexpected daemon base repository: ${pull.base?.repo?.full_name}`);
  }
  if (pull.head?.repo?.full_name !== DAEMON_REPOSITORY) {
    throw new Error('linked daemon pull request must use an internal branch');
  }

  return {
    event_type: 'daemon-pr-merged',
    client_payload: {
      source_repository: DAEMON_REPOSITORY,
      daemon_pr_number: requirePositiveInteger(pull.number, 'pull.number'),
      daemon_head_sha: requireSha(pull.head?.sha, 'pull.head.sha'),
      daemon_merge_sha: requireSha(pull.merge_commit_sha, 'pull.merge_commit_sha'),
      daemon_base_ref: 'main',
    },
  };
}

async function githubRequest(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${requireValue(token, 'GitHub token')}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'kb1-linked-cloud-repin-dispatch',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${detail}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  const line = `${name}=${value}\n`;
  if (outputPath) {
    appendFileSync(outputPath, line);
  } else {
    process.stdout.write(line);
  }
}

async function resolve() {
  if (process.env.GITHUB_REPOSITORY !== DAEMON_REPOSITORY) {
    throw new Error(`workflow must run in ${DAEMON_REPOSITORY}`);
  }

  const eventPath = requireValue(process.env.GITHUB_EVENT_PATH, 'GITHUB_EVENT_PATH');
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  let pull;

  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    if (event.action !== 'closed') {
      throw new Error(`unexpected pull_request action: ${event.action}`);
    }
    pull = event.pull_request;
  } else if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    const pullNumber = requirePositiveInteger(
      event.inputs?.daemon_pr_number,
      'inputs.daemon_pr_number',
    );
    pull = await githubRequest(`/repos/${DAEMON_REPOSITORY}/pulls/${pullNumber}`, {
      token: process.env.DAEMON_GITHUB_TOKEN,
    });
  } else {
    throw new Error(`unsupported event: ${process.env.GITHUB_EVENT_NAME}`);
  }

  const payload = buildDispatchPayload(pull);
  writeOutput('payload', JSON.stringify(payload));
  writeOutput('daemon_pr_number', String(payload.client_payload.daemon_pr_number));
}

async function dispatch() {
  const payload = JSON.parse(requireValue(process.env.DISPATCH_PAYLOAD, 'DISPATCH_PAYLOAD'));
  buildDispatchPayload({
    number: payload.client_payload?.daemon_pr_number,
    state: 'closed',
    merged_at: 'validated-by-resolve',
    merge_commit_sha: payload.client_payload?.daemon_merge_sha,
    base: {
      ref: payload.client_payload?.daemon_base_ref,
      repo: { full_name: payload.client_payload?.source_repository },
    },
    head: {
      sha: payload.client_payload?.daemon_head_sha,
      repo: { full_name: payload.client_payload?.source_repository },
    },
  });
  if (payload.event_type !== 'daemon-pr-merged') {
    throw new Error(`unexpected event type: ${payload.event_type}`);
  }

  await githubRequest(`/repos/${CLOUD_REPOSITORY}/dispatches`, {
    token: process.env.CLOUD_GITHUB_TOKEN,
    method: 'POST',
    body: payload,
  });
}

const commands = { resolve, dispatch };

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const command = process.argv[2];
  if (!commands[command]) {
    throw new Error(
      `usage: node scripts/linked-cloud-repin-dispatch.mjs ${Object.keys(commands).join('|')}`,
    );
  }
  await commands[command]();
}
