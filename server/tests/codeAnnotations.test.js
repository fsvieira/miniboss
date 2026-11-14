'use strict';

const assert = require('assert');
const { DatabaseConnection, DatabaseAPI } = require('../services/db');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${label}`);
  } catch (err) {
    console.error(`❌ ${label}`);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
    throw err;
  }
}

// A fresh :memory: DB with the DDL the annotation methods depend on. We can't
// reuse server/database.js (it opens a real file), so we create the minimal
// tables ourselves: a `projects` row for the FK and `code_annotations`.
function makeDb() {
  const connection = new DatabaseConnection(':memory:');
  connection.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT
    );
    CREATE TABLE code_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      line_start INTEGER NOT NULL CHECK(line_start >= 1),
      line_end INTEGER NOT NULL CHECK(line_end >= line_start),
      note TEXT NOT NULL,
      tags TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_code_annotations_project
      ON code_annotations(project_id, file_path, line_start);
  `);
  connection.exec(`INSERT INTO projects (name) VALUES ('Test Project')`);
  return new DatabaseAPI(connection);
}

function runTests() {
  console.log('Running codeAnnotations tests...\n');

  const db = makeDb();

  check('createCodeAnnotation inserts and returns a normalized annotation', () => {
    const a = db.createCodeAnnotation({
      project_id: 1,
      file_path: 'src/app.js',
      line_start: 3,
      line_end: 5,
      note: 'handle edge case',
      tags: ['bug'],
    });
    assert.strictEqual(a.project_id, 1);
    assert.strictEqual(a.file_path, 'src/app.js');
    assert.strictEqual(a.line_start, 3);
    assert.strictEqual(a.line_end, 5);
    assert.deepStrictEqual(a.tags, ['bug']);
    assert.ok(a.id >= 1);
    assert.ok(a.created_at);
  });

  check('tags stored as JSON round-trip to an array', () => {
    const a = db.createCodeAnnotation({
      project_id: 1, file_path: 'tags.js', line_start: 1, line_end: 1, note: 'tagged', tags: ['a', 'b'],
    });
    assert.deepStrictEqual(a.tags, ['a', 'b']);
    assert.deepStrictEqual(db.getCodeAnnotation(a.id).tags, ['a', 'b']);
  });

  check('getCodeAnnotation returns null for a missing id', () => {
    assert.strictEqual(db.getCodeAnnotation(9999), null);
  });

  check('getCodeAnnotation returns a stored annotation by id', () => {
    const a = db.getCodeAnnotation(1);
    assert.ok(a);
    assert.strictEqual(a.note, 'handle edge case');
    assert.deepStrictEqual(a.tags, ['bug']);
  });

  check('getCodeAnnotationsByFile orders by line_start', () => {
    db.createCodeAnnotation({
      project_id: 1,
      file_path: 'src/app.js',
      line_start: 10,
      line_end: 12,
      note: 'later',
      tags: null,
    });
    db.createCodeAnnotation({
      project_id: 1,
      file_path: 'src/app.js',
      line_start: 1,
      line_end: 2,
      note: 'earlier',
      tags: ['refactor'],
    });
    const list = db.getCodeAnnotationsByFile(1, 'src/app.js');
    assert.deepStrictEqual(list.map((a) => a.line_start), [1, 3, 10]);
  });

  check('getCodeAnnotationsByFile is scoped to project and file', () => {
    db.createCodeAnnotation({
      project_id: 1,
      file_path: 'other.js',
      line_start: 1,
      line_end: 1,
      note: 'other file',
      tags: null,
    });
    const onlyOther = db.getCodeAnnotationsByFile(1, 'other.js');
    assert.strictEqual(onlyOther.length, 1);
    assert.ok(db.getCodeAnnotationsByFile(2, 'src/app.js').length === 0);
  });

  check('overlapping ranges are allowed', () => {
    db.createCodeAnnotation({
      project_id: 1,
      file_path: 'overlap.js',
      line_start: 5,
      line_end: 10,
      note: 'first',
      tags: null,
    });
    db.createCodeAnnotation({
      project_id: 1,
      file_path: 'overlap.js',
      line_start: 8,
      line_end: 20,
      note: 'second overlaps',
      tags: null,
    });
    assert.strictEqual(db.getCodeAnnotationsByFile(1, 'overlap.js').length, 2);
  });

  check('schema CHECK enforces line_start >= 1 and line_start <= line_end', () => {
    assert.throws(() => db.createCodeAnnotation({
      project_id: 1, file_path: 'x.js', line_start: 0, line_end: 2, note: 'n', tags: null,
    }), (err) => /CHECK/.test(String(err.message)));
    assert.throws(() => db.createCodeAnnotation({
      project_id: 1, file_path: 'x.js', line_start: 5, line_end: 3, note: 'n', tags: null,
    }), (err) => /CHECK/.test(String(err.message)));
  });

  check('updateCodeAnnotation updates note/tags/range', () => {
    const updated = db.updateCodeAnnotation(1, {
      note: 'rewritten',
      tags: ['critical'],
      line_start: 4,
      line_end: 6,
    });
    assert.strictEqual(updated.note, 'rewritten');
    assert.deepStrictEqual(updated.tags, ['critical']);
    assert.strictEqual(updated.line_start, 4);
    assert.strictEqual(updated.line_end, 6);
  });

  check('updateCodeAnnotation with empty updates returns the unchanged row', () => {
    const current = db.updateCodeAnnotation(1, {});
    assert.strictEqual(current.note, 'rewritten');
  });

  check('updateCodeAnnotation returns null for a missing id', () => {
    assert.strictEqual(db.updateCodeAnnotation(9876, { note: 'x' }), null);
  });

  check('deleteCodeAnnotation returns boolean and removes the row', () => {
    const id = db.createCodeAnnotation({
      project_id: 1, file_path: 'del.js', line_start: 1, line_end: 1, note: 'gone', tags: null,
    }).id;
    assert.strictEqual(db.deleteCodeAnnotation(id), true);
    assert.strictEqual(db.getCodeAnnotation(id), null);
    assert.strictEqual(db.deleteCodeAnnotation(id), false);
  });

  check('searchCodeAnnotations matches note and tags', () => {
    db.createCodeAnnotation({
      project_id: 1, file_path: 's.js', line_start: 1, line_end: 2, note: 'authorize request', tags: ['security'],
    });
    const byNote = db.searchCodeAnnotations(1, 'authorize');
    assert.ok(byNote.some((a) => a.note === 'authorize request'));
    const byTag = db.searchCodeAnnotations(1, 'secur');
    assert.ok(byTag.some((a) => (a.tags || []).includes('security')));
    assert.deepStrictEqual(db.searchCodeAnnotations(1, ''), []);
    assert.deepStrictEqual(db.searchCodeAnnotations(1, 'zzz-no-match'), []);
  });

  check('searchCodeAnnotations respects limit', () => {
    for (let i = 0; i < 3; i += 1) {
      db.createCodeAnnotation({
        project_id: 1, file_path: 'lim.js', line_start: i + 1, line_end: i + 1, note: `hit ${i}`, tags: null,
      });
    }
    const limited = db.searchCodeAnnotations(1, 'hit', 2);
    assert.ok(limited.length <= 2);
  });

  console.log(`\nAll codeAnnotations tests passed (${passed} checks).`);
}

runTests();
