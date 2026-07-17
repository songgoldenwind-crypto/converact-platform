import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LIVEKIT_UPSTREAM_COMMIT,
  LIVEKIT_UPSTREAM_TAG,
  applyPinnedPatch,
  patchLiveKitGoMod,
  patchLiveKitRoomManager,
  patchLiveKitServerMain
} from '../infra/ivekit/livekit/apply-overlay.mjs';

test('LiveKit owner overlay is exact-tag bound and patches every owner boundary', () => {
  assert.equal(LIVEKIT_UPSTREAM_TAG, 'v1.13.3');
  assert.equal(
    LIVEKIT_UPSTREAM_COMMIT,
    '8f6a9cb8b735549f0c5770df8ea70ac51f860ecb'
  );
  const patched = patchLiveKitRoomManager(roomManagerFixture());

  assert.match(patched, /ivekitowner "ivekit\.local\/livekitowner"/);
  assert.match(patched, /ivekitOwners \*livekitowner\.Registry/);
  assert.match(patched, /NewRegistryFromEnv/);
  assert.match(patched, /OpenOrAssert/);
  assert.match(patched, /opened, ownerErr := r\.ivekitOwners\.OpenOrAssert/);
  assert.doesNotMatch(patched, /ownerOpened, err = r\.ivekitOwners\.OpenOrAssert/);
  assert.match(patched, /ivekitOwners\.Start/);
  assert.match(patched, /ivekitOwners\.Stop/);
  assert.match(patched, /ivekitOwners\.Assert\(string\(room\.Name\(\)\), time\.Now\(\)\)/);
  assert.match(patched, /could not close ivekit room owner/);
  assert.match(patched, /func \(r \*RoomManager\) SendData[\s\S]*ivekitOwners\.Assert\(req\.Room/);
  assert.match(patched, /func \(r \*RoomManager\) UpdateRoomMetadata[\s\S]*ivekitOwners\.Assert\(req\.Room/);
  assert.equal(patchLiveKitRoomManager(patched), patched);

  const gofmtAligned = patched.replace(
    '\t\tivekitOwners:     ivekitOwners,',
    '\t\tivekitOwners:      ivekitOwners,'
  );
  assert.equal(patchLiveKitRoomManager(gofmtAligned), gofmtAligned);
});

test('LiveKit owner overlay aligns the internal Redis router node identity', () => {
  const patched = patchLiveKitServerMain(serverMainFixture());

  assert.match(
    patched,
    /ownerNodeID := strings\.TrimSpace\(os\.Getenv\("IVEKIT_COMPONENT_NODE_ID"\)\)/
  );
  assert.match(
    patched,
    /currentNode\.SetNodeID\(livekit\.NodeID\(ownerNodeID\)\)/
  );
  assert.match(patched, /"strings"/);
  assert.match(patched, /"github\.com\/livekit\/protocol\/livekit"/);
  assert.ok(
    patched.indexOf('currentNode.SetNodeID') <
      patched.indexOf('prometheus.Init')
  );
  assert.equal(patchLiveKitServerMain(patched), patched);
});

test('LiveKit owner overlay adds only local replace modules to pinned go.mod', () => {
  const patched = patchLiveKitGoMod(
    'module github.com/livekit/livekit-server\n\ngo 1.26\n'
  );
  assert.match(patched, /require ivekit\.local\/livekitowner v0\.0\.0/);
  assert.match(
    patched,
    /ivekit\.local\/componenthook v0\.0\.0 \/\/ indirect/
  );
  assert.match(
    patched,
    /replace ivekit\.local\/componenthook => \.\/ivekit\/component-hook-go/
  );
  assert.match(
    patched,
    /replace ivekit\.local\/livekitowner => \.\/ivekit\/livekit-owner/
  );
  assert.equal(patchLiveKitGoMod(patched), patched);
});

test('LiveKit owner build files state the real compile boundary', () => {
  const build = readFileSync('infra/ivekit/livekit/build.sh', 'utf8');
  const readme = readFileSync('infra/ivekit/livekit/README.md', 'utf8');
  assert.match(build, /go test -C "\$\{LIVEKIT_SOURCE_DIR\}" \.\/cmd\/server/);
  assert.match(build, /\.\/pkg\/sfu \.\/pkg\/sfu\/utils/);
  assert.match(build, /ivekit\/component-hook-go" \.\/\.\.\./);
  assert.match(build, /ivekit\/livekit-owner" \.\/\.\.\./);
  assert.doesNotMatch(build, /\.\/pkg\/service/);
  assert.doesNotMatch(build, /\.\/ivekit\/\.\.\./);
  assert.match(build, /docker build/);
  assert.match(readme, /Go 1\.26/);
  assert.match(readme, /custom image build[\s\S]*remain `not_run`/);
});

test('LiveKit pinned patches apply once and are idempotent', () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'ivekit-livekit-patch-'));
  const sourcePath = join(sourceDir, 'source.txt');
  const patchPath = join(sourceDir, 'change.patch');
  execFileSync('git', ['init', '--quiet', sourceDir]);
  writeFileSync(sourcePath, 'before\n');
  writeFileSync(
    patchPath,
    [
      'diff --git a/source.txt b/source.txt',
      '--- a/source.txt',
      '+++ b/source.txt',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      ''
    ].join('\n')
  );

  assert.equal(applyPinnedPatch(sourceDir, patchPath), 'applied');
  assert.equal(readFileSync(sourcePath, 'utf8'), 'after\n');
  assert.equal(applyPinnedPatch(sourceDir, patchPath), 'already_applied');
});

test('LiveKit small-room patch removes locks and heap aggregation from 1:1 RTP fanout', () => {
  const hotPathPatch = readFileSync(
    'infra/ivekit/livekit/patches/livekit-ivekit-small-room-hot-path.patch',
    'utf8'
  );
  assert.match(hotPathPatch, /atomic\.Pointer\[\[\]T\]/);
  assert.match(hotPathPatch, /ShouldParallel/);
  assert.match(hotPathPatch, /writeRTPToDownTracks/);
  assert.match(hotPathPatch, /TestWriteRTPToDownTracksUsesSerialSmallRoomPath/);
  assert.match(hotPathPatch, /TestDownTrackSpreaderConcurrentSnapshotReads/);
  assert.doesNotMatch(hotPathPatch, /http\.|postgres|redis|nats/i);
});

function serverMainFixture(): string {
  return [
    'package main',
    '',
    'import (',
    '\t"os"',
    '\t"runtime/pprof"',
    '\t"syscall"',
    '',
    '\t"github.com/livekit/protocol/logger"',
    ')',
    '',
    'func startServer() error {',
    '\tcurrentNode, err := routing.NewLocalNode(conf)',
    '\tif err != nil {',
    '\t\treturn err',
    '\t}',
    '',
    '\tif err := prometheus.Init(string(currentNode.NodeID()), currentNode.NodeType()); err != nil {',
    '\t\treturn err',
    '\t}',
    '\treturn nil',
    '}',
    ''
  ].join('\n');
}

function roomManagerFixture(): string {
  return [
    'package service',
    '',
    'import (',
    '\t"github.com/livekit/psrpc/pkg/middleware"',
    '',
    '\t"github.com/livekit/livekit-server/pkg/agent"',
    ')',
    '',
    'type RoomManager struct {',
    '\tforwardStats *sfu.ForwardStats',
    '',
    '\trpc.UnimplementedParticipantServer',
    '}',
    '',
    'func NewLocalRoomManager() (*RoomManager, error) {',
    '\trtcConf, err := rtc.NewWebRTCConfig(conf)',
    '\tif err != nil {',
    '\t\treturn nil, err',
    '\t}',
    '',
    '\tr := &RoomManager{',
    '\t\tforwardStats:      forwardStats,',
    '',
    '\t\trooms: make(map[livekit.RoomName]*rtc.Room),',
    '\t}',
    '\tif err := r.whipServer.RegisterAllCommonTopics(currentNode.NodeID()); err != nil {',
    '\t\treturn nil, err',
    '\t}',
    '',
    '\treturn r, nil',
    '}',
    '',
    'func (r *RoomManager) Stop() {',
    '\t// disconnect all clients',
    '}',
    '',
    'func (r *RoomManager) StartSession() error {',
    '\tcreateRoom := pi.CreateRoom',
    '\troom, err := r.getOrCreateRoom(ctx, createRoom)',
    '\tif err != nil {',
    '\t\treturn err',
    '\t}',
    '\t_ = room',
    '\treturn nil',
    '}',
    '',
    'func (r *RoomManager) getOrCreateRoom() {',
    '\tnewRoom.OnClose(func() {',
    '\t\tkillRoomServer()',
    '\t})',
    '}',
    '',
    'func (r *RoomManager) rtcSessionWorker() {',
    '\t\t\tif err := participant.HandleSignalMessage(obj); err != nil {',
    '\t\t\t\treturn',
    '\t\t\t}',
    '}',
    '',
    'func (r *RoomManager) roomAndParticipantForReq(ctx context.Context, req participantReq) (*rtc.Room, types.LocalParticipant, error) {',
    '\troom := r.GetRoom(ctx, livekit.RoomName(req.GetRoom()))',
    '\tif room == nil {',
    '\t\treturn nil, nil, ErrRoomNotFound',
    '\t}',
    '',
    '\tparticipant := room.GetParticipant(livekit.ParticipantIdentity(req.GetIdentity()))',
    '\treturn room, participant, nil',
    '}',
    '',
    'func (r *RoomManager) DeleteRoom(ctx context.Context, req *livekit.DeleteRoomRequest) (*livekit.DeleteRoomResponse, error) {',
    '\tif room == nil {',
    '\t\treturn nil, ErrRoomNotFound',
    '\t} else {',
    '\t\troom.Logger().Infow("deleting room")',
    '\t\troom.Close(types.ParticipantCloseReasonServiceRequestDeleteRoom)',
    '\t}',
    '\treturn nil, nil',
    '}',
    '',
    'func (r *RoomManager) SendData(ctx context.Context, req *livekit.SendDataRequest) (*livekit.SendDataResponse, error) {',
    '\troom := r.GetRoom(ctx, livekit.RoomName(req.Room))',
    '\tif room == nil {',
    '\t\treturn nil, ErrRoomNotFound',
    '\t}',
    '\treturn nil, nil',
    '}',
    '',
    'func (r *RoomManager) UpdateRoomMetadata(ctx context.Context, req *livekit.UpdateRoomMetadataRequest) (*livekit.Room, error) {',
    '\troom := r.GetRoom(ctx, livekit.RoomName(req.Room))',
    '\tif room == nil {',
    '\t\treturn nil, ErrRoomNotFound',
    '\t}',
    '\treturn nil, nil',
    '}',
    ''
  ].join('\n');
}
