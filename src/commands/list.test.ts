import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError } from '../errors.js';
import { cli, getRegistry, Strategy } from '../registry.js';
import { registerListCommand } from './list.js';

describe('list command', () => {
  beforeEach(() => {
    getRegistry().clear();
  });

  function createProgram(): Command {
    const program = new Command();
    program.exitOverride(); // Prevent process.exit in tests
    registerListCommand(program);
    return program;
  }

  it('exports full metadata without pagination when --manifest is used (>25 commands)', async () => {
    // Register 30 commands across different sites
    for (let i = 1; i <= 30; i++) {
      cli({
        site: `site-${i % 3}`,
        name: `cmd-${String(i).padStart(2, '0')}`,
        access: 'read',
        description: `Command ${i}`,
        strategy: Strategy.PUBLIC,
        browser: false,
        args: [
          { name: 'input', help: 'Input arg' },
        ],
      });
    }

    const program = createProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'opencli', 'list', '--manifest', '-f', 'json']);

    expect(logSpy).toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.ok).toBe(true);
    expect(Array.isArray(output.data)).toBe(true);
    expect(output.data).toHaveLength(30);

    // Verify commands are ordered by full name
    const names = output.data.map((c: any) => c.command);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);

    // Verify it contains full metadata, not summary
    const first = output.data[0];
    expect(first).toHaveProperty('command');
    expect(first).toHaveProperty('site');
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('access');
    expect(first).toHaveProperty('strategy');
    expect(first).toHaveProperty('browser');
    expect(first).toHaveProperty('args');
    expect(first).toHaveProperty('example');

    // Management commands (like list) should NOT be in the manifest output
    expect(output.data.some((c: any) => c.command === 'list')).toBe(false);

    logSpy.mockRestore();
  });

  it('preserves args.repeatable, siteSession, and defaultWindowMode in --manifest metadata', async () => {
    cli({
      site: 'chatgpt',
      name: 'ask',
      access: 'write',
      description: 'Ask ChatGPT',
      strategy: Strategy.COOKIE,
      browser: true,
      defaultWindowMode: 'background',
      siteSession: 'persistent',
      args: [
        {
          name: 'file',
          help: 'File path',
          repeatable: true,
        },
        {
          name: 'query',
          help: 'User query',
        },
      ],
    });

    const program = createProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'opencli', 'list', '--manifest', '-f', 'json']);

    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.ok).toBe(true);
    const cmd = output.data.find((c: any) => c.command === 'chatgpt/ask');
    expect(cmd).toBeDefined();
    expect(cmd.defaultWindowMode).toBe('background');
    expect(cmd.siteSession).toBe('persistent');

    const fileArg = cmd.args.find((a: any) => a.name === 'file');
    expect(fileArg).toMatchObject({
      name: 'file',
      repeatable: true,
    });

    const queryArg = cmd.args.find((a: any) => a.name === 'query');
    expect(queryArg).toMatchObject({
      name: 'query',
      repeatable: false,
    });

    logSpy.mockRestore();
  });

  it('includes dynamic plugin commands in --manifest export', async () => {
    cli({
      site: 'builtin-site',
      name: 'builtin-cmd',
      access: 'read',
      description: 'Builtin command',
      strategy: Strategy.PUBLIC,
      browser: false,
      args: [],
    });

    // Simulate dynamically registered plugin command
    cli({
      site: 'custom-plugin',
      name: 'plugin-action',
      access: 'read',
      description: 'Dynamic plugin action',
      strategy: Strategy.PUBLIC,
      browser: false,
      args: [{ name: 'flag', repeatable: true }],
    });

    const program = createProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'opencli', 'list', '--manifest', '-f', 'json']);

    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.ok).toBe(true);
    const commands = output.data.map((c: any) => c.command);
    expect(commands).toContain('builtin-site/builtin-cmd');
    expect(commands).toContain('custom-plugin/plugin-action');

    logSpy.mockRestore();
  });

  it('filters by --site in --manifest mode', async () => {
    cli({
      site: 'site-a',
      name: 'cmd-1',
      access: 'read',
      description: 'Site A command',
      strategy: Strategy.PUBLIC,
      browser: false,
      args: [],
    });
    cli({
      site: 'site-b',
      name: 'cmd-2',
      access: 'read',
      description: 'Site B command',
      strategy: Strategy.PUBLIC,
      browser: false,
      args: [],
    });

    const program = createProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'opencli', 'list', '--manifest', '--site', 'site-a', '-f', 'json']);

    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.ok).toBe(true);
    expect(output.data).toHaveLength(1);
    expect(output.data[0].command).toBe('site-a/cmd-1');

    logSpy.mockRestore();
  });

  it('rejects combining --manifest with a query argument', async () => {
    const program = createProgram();
    await expect(program.parseAsync(['node', 'opencli', 'list', 'search-term', '--manifest']))
      .rejects.toThrow(ArgumentError);
  });

  it('rejects combining --manifest with --limit', async () => {
    const program = createProgram();
    await expect(program.parseAsync(['node', 'opencli', 'list', '--manifest', '--limit', '10']))
      .rejects.toThrow(ArgumentError);
  });

  it('rejects combining --manifest with --offset', async () => {
    const program = createProgram();
    await expect(program.parseAsync(['node', 'opencli', 'list', '--manifest', '--offset', '5']))
      .rejects.toThrow(ArgumentError);
  });

  it('preserves standard list contract when --manifest is not specified', async () => {
    for (let i = 1; i <= 30; i++) {
      cli({
        site: 'demo',
        name: `cmd-${i}`,
        access: 'read',
        description: `Description ${i}`,
        strategy: Strategy.PUBLIC,
        browser: false,
        args: [],
      });
    }

    const program = createProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'opencli', 'list', '-f', 'json']);

    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.ok).toBe(true);
    // Standard list contract: commands array, total count, nextOffset
    expect(output.data).toHaveProperty('commands');
    expect(output.data).toHaveProperty('total');
    expect(output.data.commands).toHaveLength(25); // default limit 25
    expect(output.data.nextOffset).toBe(25);
    expect(output.data.total).toBeGreaterThan(25);

    logSpy.mockRestore();
  });
});
