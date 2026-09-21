import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { jj } from "../server/process.ts";

const notifications = `import type { Preferences } from './preferences';

export interface Notification {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  channel: 'email' | 'push';
}

export interface DeliveryResult {
  delivered: boolean;
  attempts: number;
  notificationId: string;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

export function formatSubject(notification: Notification): string {
  return notification.subject;
}

export function canDeliver(notification: Notification, preferences: Preferences): boolean {
  if (notification.channel === 'email') return preferences.email;
  return preferences.push;
}

export async function deliverNotification(
  notification: Notification,
  send: (notification: Notification) => Promise<void>,
): Promise<DeliveryResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await send(notification);
      return { delivered: true, attempts: attempt, notificationId: notification.id };
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return { delivered: false, attempts: MAX_ATTEMPTS, notificationId: notification.id };
}

export function deliveryKey(notification: Notification): string {
  return notification.id;
}
`;
const preferences = `export interface Preferences {
  email: boolean;
  push: boolean;
  digest: 'daily' | 'weekly' | 'off';
  timezone: string;
}

export const defaultPreferences: Preferences = {
  email: true,
  push: true,
  digest: 'off',
  timezone: 'UTC',
};

export function updatePreferences(
  current: Preferences,
  changes: Partial<Preferences>,
): Preferences {
  return { ...current, ...changes };
}

export function wantsDigest(preferences: Preferences): boolean {
  return preferences.digest !== 'off';
}

export function preferenceSummary(preferences: Preferences): string {
  const channels = [];
  if (preferences.email) channels.push('email');
  if (preferences.push) channels.push('push');
  return channels.join(', ');
}
`;
const tests = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatSubject, deliveryKey, canDeliver } from '../src/notifications';
import { defaultPreferences, wantsDigest } from '../src/preferences';

const notification = {
  id: 'ntf_123',
  recipient: 'team@orbit.dev',
  subject: 'Your weekly update',
  body: 'Three new projects are ready to explore.',
  channel: 'email' as const,
};

describe('notification delivery', () => {
  it('formats the subject', () => {
    assert.equal(formatSubject(notification), 'Your weekly update');
  });

  it('uses the notification id as delivery key', () => {
    assert.equal(deliveryKey(notification), 'ntf_123');
  });

  it('respects email preferences', () => {
    assert.equal(canDeliver(notification, defaultPreferences), true);
    assert.equal(canDeliver(notification, { ...defaultPreferences, email: false }), false);
  });

  it('keeps digests disabled by default', () => {
    assert.equal(wantsDigest(defaultPreferences), false);
  });
});
`;

/** Test-only generated repository; callers explicitly pass its path to ReviewService. */
export async function createDemo(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const root = await mkdtemp(path.join(dataDir, "demo-"));
  await jj(dataDir, ["git", "init", "--no-colocate", root]);
  await jj(root, ["config", "set", "--repo", "user.name", "Orbit Team"]);
  await jj(root, ["config", "set", "--repo", "user.email", "team@orbit.dev"]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    "root()",
  ]);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "tests"));
  await writeFile(path.join(root, "src/notifications.ts"), notifications);
  await writeFile(
    path.join(root, "src/preferences.ts"),
    preferences.replace("digest: 'off',", "digest: 'daily',"),
  );
  await writeFile(path.join(root, "tests/notifications.test.ts"), tests);
  await jj(root, ["commit", "-m", "Build notification delivery service"]);
  await writeFile(path.join(root, "src/preferences.ts"), preferences);
  await jj(root, ["commit", "-m", "Add notification preferences"]);
  // Two independent changes per file, separated by enough context for six hunks.
  await writeFile(
    path.join(root, "src/notifications.ts"),
    notifications
      .replace(
        "return notification.subject;",
        "return `[orbit] ${notification.subject.trim()}`;",
      )
      .replace(
        "setTimeout(resolve, RETRY_DELAY_MS)",
        "setTimeout(resolve, RETRY_DELAY_MS * attempt)",
      ),
  );
  await writeFile(
    path.join(root, "src/preferences.ts"),
    preferences
      .replace("push: true,", "push: false,")
      .replace(
        "return channels.join(', ');",
        "return channels.length ? channels.join(', ') : 'All notifications paused';",
      ),
  );
  await writeFile(
    path.join(root, "tests/notifications.test.ts"),
    tests
      .replace(
        "assert.equal(formatSubject(notification), 'Your weekly update');",
        "assert.equal(formatSubject(notification), '[orbit] Your weekly update');\n    assert.equal(formatSubject({ ...notification, subject: '  Hello  ' }), '[orbit] Hello');",
      )
      .replace(
        "assert.equal(wantsDigest(defaultPreferences), false);",
        "assert.equal(wantsDigest(defaultPreferences), false);\n    assert.equal(wantsDigest({ ...defaultPreferences, digest: 'weekly' }), true);\n    assert.equal(defaultPreferences.push, false);",
      ),
  );
  await jj(root, ["describe", "-m", "Polish notification delivery"]);
  return root;
}
