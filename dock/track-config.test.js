const test = require("node:test");
const assert = require("node:assert/strict");
const { TRACK_COUNT, defaultConfig, migrateConfig } = require("./track-config.js");

test("初期設定はトラック6まで持つ", () => {
  const config = defaultConfig();
  assert.equal(TRACK_COUNT, 6);
  assert.deepEqual(config.trackNames, [
    "配信",
    "録画",
    "トラック3",
    "トラック4",
    "トラック5",
    "トラック6",
  ]);
});

test("保存済みの5件は残し、6件目だけ初期名を足す", () => {
  const migrated = migrateConfig({
    host: "192.168.0.5",
    port: 4456,
    password: "secret",
    trackNames: ["ライブ", "アーカイブ", "SE", "マイク", "予備"],
  });

  assert.equal(migrated.host, "192.168.0.5");
  assert.equal(migrated.port, 4456);
  assert.equal(migrated.password, "secret");
  assert.deepEqual(migrated.trackNames, [
    "ライブ",
    "アーカイブ",
    "SE",
    "マイク",
    "予備",
    "トラック6",
  ]);
});

test("空欄は同じ位置の初期名に戻り、後ろの名前はずれない", () => {
  const migrated = migrateConfig({
    trackNames: ["配信", "  ", "効果音", "トラック4", "トラック5"],
  });

  assert.deepEqual(migrated.trackNames, [
    "配信",
    "録画",
    "効果音",
    "トラック4",
    "トラック5",
    "トラック6",
  ]);
});

test("文字列でない要素は初期名に戻す", () => {
  const migrated = migrateConfig({
    trackNames: ["配信", 2, null, "トラック4", "トラック5"],
  });

  assert.deepEqual(migrated.trackNames, [
    "配信",
    "録画",
    "トラック3",
    "トラック4",
    "トラック5",
    "トラック6",
  ]);
});

test("既に6件ある名前はそのまま使う", () => {
  const names = ["A", "B", "C", "D", "E", "F"];
  assert.deepEqual(migrateConfig({ trackNames: names }).trackNames, names);
});

test("7件目以降はOBSのトラック数に合わせて捨てる", () => {
  const migrated = migrateConfig({
    trackNames: ["A", "B", "C", "D", "E", "F", "G"],
  });
  assert.deepEqual(migrated.trackNames, ["A", "B", "C", "D", "E", "F"]);
});

test("trackNames が配列でなければ初期名を使う", () => {
  const migrated = migrateConfig({ trackNames: "配信", host: "localhost" });
  assert.deepEqual(migrated.trackNames, defaultConfig().trackNames);
  assert.equal(migrated.host, "localhost");
});

test("壊れた保存値は初期設定に戻す", () => {
  assert.deepEqual(migrateConfig(null).trackNames, defaultConfig().trackNames);
  assert.deepEqual(migrateConfig([]).trackNames, defaultConfig().trackNames);
});
