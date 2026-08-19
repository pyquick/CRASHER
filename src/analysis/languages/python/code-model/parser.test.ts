import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parsePythonSource } from './parser.js';
import { buildSnapshotModel } from './index.js';
import type { AnalysisSourceSnapshot } from '../../../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleAppDir = join(here, '..', 'samples', 'sample_app');

function parseFixture(relative: string) {
  const content = readFileSync(join(sampleAppDir, relative), 'utf-8');
  return parsePythonSource(relative, content);
}

function snapshotOfFiles(files: Array<{ relative_path: string; content: string }>): AnalysisSourceSnapshot {
  return {
    project_name: 'sample_app',
    requested_release: '',
    snapshot_release: '',
    snapshot_id: 1,
    match_type: 'exact',
    files: files.map(file => ({ ...file, language: 'python' })),
  };
}

test('parses imports and from-imports with aliases', () => {
  const model = parseFixture('app.py');
  const modules = model.imports.map(item => item.module);
  assert.ok(modules.includes('os'));
  assert.ok(modules.includes('services.user_service'));
  assert.ok(modules.includes('config'));

  const getter = model.imports.find(item => item.name === 'get_user');
  assert.ok(getter, 'get_user import found');
  assert.equal(getter.is_from, true);
  assert.equal(getter.module, 'services.user_service');
});

test('preserves import aliases, qualified bindings, and relative modules', () => {
  const model = parsePythonSource('pkg/consumer.py', [
    'from .constants import Constants as AppConstants',
    'from . import helpers',
    'from pkg.tools import (Runner as ToolRunner, helper)',
    'import vendor.constants',
    'import vendor.helpers as vendor_helpers',
  ].join('\n'));

  const appConstants = model.imports.find(item => item.name === 'AppConstants');
  assert.ok(appConstants);
  assert.equal(appConstants.module, '.constants');
  assert.equal(appConstants.imported_name, 'Constants');

  const helpers = model.imports.find(item => item.module === '.' && item.name === 'helpers');
  assert.ok(helpers, 'relative package import parsed');
  assert.equal(helpers.imported_name, 'helpers');

  const toolRunner = model.imports.find(item => item.name === 'ToolRunner');
  assert.ok(toolRunner, 'parenthesized from-import parsed');
  assert.equal(toolRunner.imported_name, 'Runner');

  const vendor = model.imports.find(item => item.module === 'vendor.constants');
  assert.ok(vendor);
  assert.equal(vendor.name, 'vendor', 'plain dotted import binds the top-level package');
  assert.equal(vendor.imported_name, 'vendor.constants');

  const vendorHelpers = model.imports.find(item => item.name === 'vendor_helpers');
  assert.ok(vendorHelpers);
  assert.equal(vendorHelpers.imported_name, 'vendor.helpers');
});

test('parses module-level assignments and functions', () => {
  const model = parseFixture('app.py');
  assert.ok(model.name_defs.has('service'), 'module assignment recorded in name_defs');
  assert.ok(model.name_defs.has('main'), 'function recorded in name_defs');

  const main = model.functions.find(func => func.name === 'main');
  assert.ok(main, 'main function found');
  assert.equal(main.qualified_name, 'main');
  assert.deepEqual(main.params, ['user_id: int']);
  assert.equal(main.kind, 'function');

  const callNames = main.calls.map(call => call.name);
  assert.ok(callNames.includes('get_user'), 'get_user call recorded');
  assert.ok(callNames.includes('print'), 'print call recorded');
  assert.ok(main.attr_accesses.some(attr => attr.receiver === 'user' && attr.attr === 'name'), 'user.name attribute access recorded');
});

test('parses classes with methods and self attribute assignments', () => {
  const model = parseFixture('models/user.py');
  const cls = model.classes.find(item => item.name === 'User');
  assert.ok(cls, 'User class found');
  assert.deepEqual(cls.bases, []);

  const init = cls.methods.find(method => method.name === '__init__');
  assert.ok(init, '__init__ method found');
  assert.equal(init.qualified_name, 'User.__init__');
  assert.equal(init.kind, 'method');
  assert.deepEqual(init.params, ['self', 'name: str', 'email: str']);
  assert.ok(init.assignments.some(a => a.name === 'self.name'), 'self.name assignment recorded');
  assert.ok(init.assignments.some(a => a.name === 'self.email'), 'self.email assignment recorded');

  const display = cls.methods.find(method => method.name === 'display_name');
  assert.ok(display, 'display_name method found');
});

test('detects explicit return None and bare None-producing paths', () => {
  const model = parseFixture('services/user_service.py');
  const getter = model.functions.find(func => func.name === 'get_user');
  assert.ok(getter, 'module-level get_user found');
  const noneReturn = getter.returns.find(ret => ret.line === 9 || ret.is_none);
  assert.ok(noneReturn && noneReturn.is_none, 'return None recorded');

  // The .get() call without a default is the real None source.
  const getCall = getter.calls.find(call => call.name === '_USERS.get');
  assert.ok(getCall, '_USERS.get call recorded');

  const service = model.classes.find(item => item.name === 'UserService');
  assert.ok(service, 'UserService class found');
  const method = service.methods.find(m => m.name === 'find_or_create');
  assert.ok(method, 'find_or_create method found');
  const selfCall = method.calls.find(call => call.name === 'self.get_user');
  assert.ok(selfCall, 'self.get_user call recorded');
  assert.equal(selfCall.receiver, 'self');

  // _USERS dict literal assignment.
  const dictAssignment = getter.assignments.find(a => a.name === 'user' && a.rhs_kind === 'call');
  assert.ok(dictAssignment, 'user = _USERS.get(...) recorded as call assignment');
});

test('handles multi-line signatures, decorators, nested functions, async def', () => {
  const source = [
    '@app.route(',
    "    '/users',",
    '    methods=[\'GET\'],',
    ')',
    'def fetch_users(',
    '    limit: int,',
    '    offset: int = 0,',
    ') -> list:',
    '    def inner(x):',
    '        return x * 2',
    '    return [inner(1)]',
    '',
    'async def run():',
    '    await fetch_users(1)',
  ].join('\n');
  const model = parsePythonSource('web.py', source);

  const fetch = model.functions.find(func => func.name === 'fetch_users');
  assert.ok(fetch, 'multi-line signature parsed');
  assert.deepEqual(fetch.params, ['limit: int', 'offset: int = 0']);
  // String literals are stripped by the tokenizer; the decorator name survives.
  assert.deepEqual(fetch.decorators, ['app.route( , methods=[ ], )']);

  const inner = model.functions.find(func => func.name === 'inner');
  assert.ok(inner, 'nested function found');
  assert.equal(inner.qualified_name, 'fetch_users.inner');

  const run = model.functions.find(func => func.name === 'run');
  assert.ok(run, 'async def parsed');
  assert.equal(run.kind, 'async_function');
});

test('ignores def-like text inside strings and comments', () => {
  const source = [
    'def real():',
    '    """',
    '    def fake():',
    '        pass',
    '    """',
    "    x = 1  # def also_fake():",
    '    return x',
  ].join('\n');
  const model = parsePythonSource('strings.py', source);
  const names = model.functions.map(func => func.name);
  assert.deepEqual(names, ['real'], 'only the real def is parsed');
});

test('records class definition line and class-level assignments', () => {
  const source = [
    'class Constants:',
    "    audio_type = 'VoodooHDA'",
    '    voodoo_patch_already = False',
    '',
    'class VoodooAudio:',
    '    def __init__(self, constants):',
    '        self._constants = Constants(constants)',
    '',
    '    def present(self):',
    '        return not self._constants.voodoo_patch_already',
  ].join('\n');
  const model = parsePythonSource('audio.py', source);

  const constants = model.classes.find(cls => cls.name === 'Constants');
  assert.ok(constants, 'Constants class found');
  assert.equal(constants.line, 1, 'class definition line recorded');
  assert.deepEqual(constants.assignments.map(a => a.name), ['audio_type', 'voodoo_patch_already']);
  assert.equal(
    constants.assignments.find(a => a.name === 'voodoo_patch_already')?.rhs_kind,
    'literal',
    'class-level literals classified'
  );

  const audio = model.classes.find(cls => cls.name === 'VoodooAudio');
  assert.ok(audio, 'VoodooAudio class found');
  assert.equal(audio.line, 5);
  const init = audio.methods.find(m => m.name === '__init__');
  assert.ok(init, '__init__ found');
  const binding = init.assignments.find(a => a.name === 'self._constants');
  assert.ok(binding, 'self._constants assignment recorded');
  assert.deepEqual(binding.rhs_calls, ['Constants'], 'constructor call recorded');
});

test('parses one-line function bodies and annotated assignments', () => {
  const model = parsePythonSource('oneliners.py', 'def f(): return 1\nx: int = 5\ny += 1\n');
  const f = model.functions.find(func => func.name === 'f');
  assert.ok(f, 'one-liner function found');
  assert.ok(f.returns.some(ret => ret.line === 1), 'return in one-liner body recorded');
  assert.ok(model.name_defs.has('x'), 'annotated assignment recorded in name_defs');
});

test('caps very large snapshots at the model limits', () => {
  const many = Array.from({ length: 305 }, (_, i) => ({
    relative_path: `pkg/mod${i}.py`,
    language: 'python',
    content: 'def f():\n    return 1\n',
  }));
  const model = buildSnapshotModel(snapshotOfFiles(many));
  assert.equal(model.files.length, 300);
  assert.equal(model.skipped_files, 5);
  assert.equal(model.truncated, true);
});

test('prioritizes an exception-named definition beyond the snapshot parse cap', () => {
  const ordinary = Array.from({ length: 305 }, (_, i) => ({
    relative_path: `pkg/mod${i}.py`,
    content: 'def ordinary():\n    return 1\n',
  }));
  const definition = {
    relative_path: 'late/constants.py',
    content: 'class Constants:\n    audio_type = "VoodooHDA"\n',
  };
  const model = buildSnapshotModel(snapshotOfFiles([...ordinary, definition]), {
    priorityDefinitionNames: ['Constants'],
  });

  assert.equal(model.files.length, 300);
  assert.equal(model.skipped_files, 6);
  assert.ok(model.by_path.has('late/constants.py'), 'definition found by scanning all files before capping');
  assert.ok(model.classes_by_name.has('constants'));
});

test('builds snapshot model with cross-file maps', () => {
  const files = readdirSync(sampleAppDir, { recursive: true })
    .filter(name => typeof name === 'string' && name.endsWith('.py'))
    .map(name => ({ relative_path: name, content: readFileSync(join(sampleAppDir, name), 'utf-8') }));
  const model = buildSnapshotModel(snapshotOfFiles(files));

  assert.equal(model.files.length, files.length);
  assert.ok(model.functions_by_name.has('get_user'), 'get_user in functions_by_name');
  assert.ok(model.qualified_functions.has('UserService.get_user'), 'qualified method lookup');
  assert.ok(model.classes_by_name.has('user'), 'User class in classes_by_name');
  assert.ok(model.imports_by_name.has('get_user'), 'imported name indexed');

  const userEdge = model.class_edges.get('User');
  assert.ok(userEdge, 'User in class_edges');
  assert.deepEqual(userEdge.bases, []);
});
