const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('../src/services/curatedLibrarySyncService');
const CuratedLibraryController = require('../src/controllers/curatedLibraryController');

const root = '00000000-0000-4000-8000-000000000000';
const nodeId = '11111111-1111-4111-8111-111111111111';
const nodeId2 = '22222222-2222-4222-8222-222222222222';
const fileId = '33333333-3333-4333-8333-333333333333';
const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const node = (uuid, parentUuid, name = 'Folder') =>
  service.__test.sanitizeNode({ uuid, parentUuid, name, nodeType: 'dir' });
const file = (parentUuid, name = 'track.mp3') =>
  service.__test.sanitizeFile({ fileId, parentUuid, fileName: name, sha256: sha, size: 0 });

test('strict Content-Range rejects wildcard, overflow and malformed ranges', () => {
  const parse = CuratedLibraryController.parseContentRange;
  assert.deepEqual(parse('bytes 0-9/10'), { start: 0, end: 9, total: 10 });
  assert.equal(parse('bytes 0-9/*'), null);
  assert.equal(parse('bytes 10-10/10'), null);
  assert.equal(parse('bytes 5-4/10'), null);
  assert.equal(parse('garbage'), null);
});

test('legacy single root parent is normalized, while ambiguous parents fail closed', () => {
  const legacyRoot = '44444444-4444-4444-8444-444444444444';
  const nodes = [node(nodeId, legacyRoot)];
  const files = [file(legacyRoot)];
  service.__test.normalizeLegacyRootParents(nodes, files);
  assert.equal(nodes[0].parentUuid, root);
  assert.equal(files[0].parentUuid, root);

  assert.throws(
    () =>
      service.__test.normalizeLegacyRootParents(
        [node(nodeId, '55555555-5555-4555-8555-555555555555')],
        [file('66666666-6666-4666-8666-666666666666')]
      ),
    /多个未知根父级/
  );
});

test('topology validator rejects cycles, missing parents and case-insensitive collisions', () => {
  assert.throws(
    () => service.__test.validateEntityTopology([node(nodeId, nodeId2), node(nodeId2, nodeId)], []),
    /循环/
  );
  assert.throws(
    () => service.__test.validateEntityTopology([node(nodeId, nodeId2)], []),
    /父级不存在/
  );
  assert.throws(
    () => service.__test.validateEntityTopology([node(nodeId, root, 'Mix')], [file(root, 'mix')]),
    /重名/
  );
});
