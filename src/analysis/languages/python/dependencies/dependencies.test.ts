import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parsePythonSource } from '../code-model/parser.js';
import { buildSnapshotModel } from '../code-model/index.js';
import type { AnalysisSourceSnapshot, AnalysisSourceFile } from '../../../types.js';
import { resolveName } from './imports.js';
import { buildCallGraph, callersOf, findDependencyChain, findCyclesContaining } from './call-graph.js';
import { attributeDefinitionSites, methodResolution, transitiveSubclasses } from './class-graph.js';
import { canReturnNone, findReadsOf, noneReturningCallees } from './dataflow.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleAppDir = join(here, '..', 'samples', 'sample_app');

function loadSampleApp() {
  const files: AnalysisSourceFile[] = readdirSync(sampleAppDir, { recursive: true })
    .filter(name => typeof name === 'string' && name.endsWith('.py'))
    .map(name => ({
      relative_path: name,
      language: 'python',
      content: readFileSync(join(sampleAppDir, name), 'utf-8'),
    }));
  const snapshot: AnalysisSourceSnapshot = {
    project_name: 'sample_app',
    requested_release: '',
    snapshot_release: '',
    snapshot_id: 1,
    match_type: 'exact',
    files,
  };
  return { model: buildSnapshotModel(snapshot), files };
}

test('resolves imported function names to their definition file', () => {
  const { model } = loadSampleApp();
  const app = model.by_path.get('app.py')!;
  const main = app.functions.find(func => func.name === 'main')!;

  const resolution = resolveName('get_user', undefined, { file: app, func: main }, model);
  assert.equal(resolution.kind, 'import');
  assert.ok(resolution.func, 'resolved to a function');
  assert.equal(resolution.func.name, 'get_user');
  assert.equal(resolution.func.qualified_name, 'get_user');
  assert.ok(resolution.func !== main);
});

test('resolves self.method calls to the enclosing class method', () => {
  const { model } = loadSampleApp();
  const serviceFile = model.by_path.get('services/user_service.py')!;
  const findOrCreate = model.qualified_functions.get('UserService.find_or_create')!;

  const resolution = resolveName('self.get_user', 'self', { file: serviceFile, func: findOrCreate }, model);
  assert.equal(resolution.kind, 'method');
  assert.equal(resolution.func.qualified_name, 'UserService.get_user');
});

test('builds a call graph with imported and method edges', () => {
  const { model } = loadSampleApp();
  const edges = buildCallGraph(model);
  const main = model.qualified_functions.get('main')!;
  const moduleGetUser = model.qualified_functions.get('get_user')!;
  const findOrCreate = model.qualified_functions.get('UserService.find_or_create')!;
  const methodGetUser = model.qualified_functions.get('UserService.get_user')!;
  const userInit = model.qualified_functions.get('User.__init__')!;

  const mainCallers = callersOf(edges, moduleGetUser);
  assert.deepEqual(mainCallers.map(edge => edge.caller.qualified_name), ['main']);
  assert.equal(mainCallers[0].kind, 'import');

  assert.ok(edges.some(edge => edge.caller === findOrCreate && edge.callee === methodGetUser && edge.kind === 'method'),
    'find_or_create → UserService.get_user (method)');
  assert.ok(edges.some(edge => edge.caller === findOrCreate && edge.callee === userInit),
    'find_or_create → User.__init__ (class instantiation)');
  assert.ok(edges.some(edge => edge.caller === main && edge.callee === moduleGetUser),
    'main → get_user');
});

test('finds dependency chains and recursion cycles', () => {
  const source = [
    'def a():',
    '    return b()',
    '',
    'def b():',
    '    return c()',
    '',
    'def c():',
    '    return a()',
  ].join('\n');
  const model = buildSnapshotModel({
    project_name: 'cycle_app',
    requested_release: '',
    snapshot_release: '',
    snapshot_id: 1,
    match_type: 'exact',
    files: [{ relative_path: 'cycle.py', language: 'python', content: source }],
  });
  const edges = buildCallGraph(model);
  const a = model.qualified_functions.get('a')!;
  const c = model.qualified_functions.get('c')!;

  const chains = findDependencyChain(edges, a, c);
  assert.ok(chains.some(path => path.join('→') === 'a→b→c'), `chain found: ${JSON.stringify(chains)}`);

  const cycles = findCyclesContaining(edges, a);
  assert.ok(cycles.some(cycle => cycle.join('→') === 'a→b→c→a'), `cycle found: ${JSON.stringify(cycles)}`);
});

test('detects self-recursion in the sample app', () => {
  const { model } = loadSampleApp();
  const validate = model.qualified_functions.get('validate_depth')!;
  const edges = buildCallGraph(model);
  const cycles = findCyclesContaining(edges, validate);
  assert.deepEqual(cycles, [['validate_depth', 'validate_depth']]);
});

test('walks class hierarchy for methods and attribute definitions', () => {
  const { model } = loadSampleApp();
  const userService = model.classes_by_name.get('userservice')![0];

  const getter = methodResolution(userService, 'get_user', model);
  assert.ok(getter, 'method found on the class');
  assert.equal(getter.cls.qualified_name, 'UserService');

  const user = model.classes_by_name.get('user')![0];
  const sites = attributeDefinitionSites(user, 'name', model);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].method_name, '__init__');
  assert.equal(sites[0].cls.qualified_name, 'User');

  assert.deepEqual(transitiveSubclasses(userService, model), []);
});

test('attributeDefinitionSites finds class-body assignments and returns the assignment', () => {
  const source = [
    'class Base:',
    '    shared = 1',
    '',
    'class Derived(Base):',
    '    def __init__(self):',
    '        self.own = 2',
  ].join('\n');
  const model = buildSnapshotModel({
    project_name: 'attrs_app',
    requested_release: '',
    snapshot_release: '',
    snapshot_id: 1,
    match_type: 'exact',
    files: [{ relative_path: 'attrs.py', language: 'python', content: source }],
  });
  const derived = model.classes_by_name.get('derived')![0];

  const classLevel = attributeDefinitionSites(derived, 'shared', model);
  assert.equal(classLevel.length, 1);
  assert.equal(classLevel[0].method_name, null, 'class-body site has no method');
  assert.equal(classLevel[0].cls.qualified_name, 'Base', 'walks into the base class');
  assert.equal(classLevel[0].assignment.name, 'shared');

  const inInit = attributeDefinitionSites(derived, 'own', model);
  assert.equal(inInit.length, 1);
  assert.equal(inInit[0].method_name, '__init__');
});

test('tracks variable reads and None-returning callees', () => {
  const { model } = loadSampleApp();
  const main = model.qualified_functions.get('main')!;
  const moduleGetUser = model.qualified_functions.get('get_user')!;

  const reads = findReadsOf(main, 'user');
  assert.ok(reads.some(read => read.kind === 'attr' && read.name === 'name'), 'user.name read found');

  // main: user = get_user(...) → get_user has 'return None'.
  const mainCallees = noneReturningCallees(model, main, 'user');
  assert.equal(mainCallees.length, 1);
  assert.equal(mainCallees[0].reason, 'explicit-none');
  assert.equal(mainCallees[0].callee, moduleGetUser);
  assert.equal(mainCallees[0].assignment.line, 10);

  // module get_user: user = _USERS.get(...) → dict.get without default.
  const innerCallees = noneReturningCallees(model, moduleGetUser, 'user');
  assert.equal(innerCallees.length, 1);
  assert.equal(innerCallees[0].reason, 'dict-get');

  assert.equal(canReturnNone(moduleGetUser), true);
  assert.equal(canReturnNone(model.qualified_functions.get('User.__init__')!), true); // no explicit returns
});

test('parsePythonSource edge: multi-target and augmented assignments', () => {
  const model = parsePythonSource('misc.py', 'x = y = 1\nself.count += 1\n');
  assert.ok(model.name_defs.has('x'), 'chained assignment target recorded');
});
