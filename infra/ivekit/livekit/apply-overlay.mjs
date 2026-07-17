#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LIVEKIT_UPSTREAM_TAG = 'v1.13.3';
export const LIVEKIT_UPSTREAM_COMMIT =
  '8f6a9cb8b735549f0c5770df8ea70ac51f860ecb';

export function applyPinnedPatch(sourceDir, patchPath) {
  const check = ['-C', sourceDir, 'apply', '--check', patchPath];
  try {
    execFileSync('git', check, { stdio: 'pipe' });
    execFileSync(
      'git',
      ['-C', sourceDir, 'apply', '--whitespace=error-all', patchPath],
      { stdio: 'pipe' }
    );
    return 'applied';
  } catch (forwardError) {
    try {
      execFileSync(
        'git',
        ['-C', sourceDir, 'apply', '--reverse', '--check', patchPath],
        { stdio: 'pipe' }
      );
      return 'already_applied';
    } catch {
      const reason = forwardError instanceof Error
        ? forwardError.message
        : String(forwardError);
      throw new Error(`LiveKit pinned patch does not apply: ${reason}`);
    }
  }
}

export function patchLiveKitGoMod(source) {
  if (!source.startsWith('module github.com/livekit/livekit-server\n')) {
    throw new Error('LiveKit go.mod module identity mismatch');
  }
  if (!/^go 1\.26$/m.test(source)) {
    throw new Error('LiveKit go.mod toolchain identity mismatch');
  }
  const overlayFragments = [
    'ivekit.local/componenthook v0.0.0 // indirect',
    'ivekit.local/livekitowner v0.0.0',
    'replace ivekit.local/componenthook => ./ivekit/component-hook-go',
    'replace ivekit.local/livekitowner => ./ivekit/livekit-owner'
  ];
  const presentFragments = overlayFragments.filter((fragment) =>
    source.includes(fragment)
  );
  if (presentFragments.length === overlayFragments.length) return source;
  if (presentFragments.length > 0) {
    throw new Error('LiveKit go.mod overlay is partially applied');
  }

  const indirectAnchor = '\tgolang.org/x/time v0.15.0 // indirect\n';
  const withComponentHook = source.includes(indirectAnchor)
    ? source.replace(
        indirectAnchor,
        `${indirectAnchor}\tivekit.local/componenthook v0.0.0 // indirect\n`
      )
    : `${source.trimEnd()}\n\nrequire ivekit.local/componenthook v0.0.0 // indirect\n`;
  return `${withComponentHook.trimEnd()}

require ivekit.local/livekitowner v0.0.0

replace ivekit.local/componenthook => ./ivekit/component-hook-go

replace ivekit.local/livekitowner => ./ivekit/livekit-owner
`;
}

export function patchLiveKitServerMain(source) {
  if (source.includes('ownerNodeID := strings.TrimSpace(os.Getenv("IVEKIT_COMPONENT_NODE_ID"))')) {
    return source;
  }
  let next = replaceOnce(
    source,
    '\t"runtime/pprof"\n\t"syscall"',
    '\t"runtime/pprof"\n\t"strings"\n\t"syscall"',
    'stable node strings import'
  );
  next = replaceOnce(
    next,
    '\t"github.com/livekit/protocol/logger"',
    '\t"github.com/livekit/protocol/livekit"\n\t"github.com/livekit/protocol/logger"',
    'stable node livekit import'
  );
  const anchor =
    '\tcurrentNode, err := routing.NewLocalNode(conf)\n' +
    '\tif err != nil {\n' +
    '\t\treturn err\n' +
    '\t}\n\n' +
    '\tif err := prometheus.Init(string(currentNode.NodeID()), currentNode.NodeType()); err != nil {';
  return replaceOnce(
    next,
    anchor,
    '\tcurrentNode, err := routing.NewLocalNode(conf)\n' +
      '\tif err != nil {\n' +
      '\t\treturn err\n' +
      '\t}\n\n' +
      '\tif ownerNodeID := strings.TrimSpace(os.Getenv("IVEKIT_COMPONENT_NODE_ID")); ownerNodeID != "" {\n' +
      '\t\tcurrentNode.SetNodeID(livekit.NodeID(ownerNodeID))\n' +
      '\t}\n\n' +
      '\tif err := prometheus.Init(string(currentNode.NodeID()), currentNode.NodeType()); err != nil {',
    'stable node identity'
  );
}

export function patchLiveKitRoomManager(source) {
  const overlayState = liveKitRoomManagerOverlayState(source);
  if (overlayState === 'complete') return source;
  if (overlayState === 'partial') {
    throw new Error('LiveKit RoomManager owner overlay is partially applied');
  }

  let next = source;
  next = replaceOnce(
    next,
    '\t"github.com/livekit/psrpc/pkg/middleware"\n\n' +
      '\t"github.com/livekit/livekit-server/pkg/agent"',
    '\t"github.com/livekit/psrpc/pkg/middleware"\n\n' +
      '\tlivekitowner "ivekit.local/livekitowner"\n\n' +
      '\t"github.com/livekit/livekit-server/pkg/agent"',
    'owner import'
  );
  next = replaceOnce(
    next,
    '\tforwardStats *sfu.ForwardStats\n\n' +
      '\trpc.UnimplementedParticipantServer',
    '\tforwardStats *sfu.ForwardStats\n' +
      '\tivekitOwners *livekitowner.Registry\n\n' +
      '\trpc.UnimplementedParticipantServer',
    'RoomManager owner field'
  );
  next = replaceOnce(
    next,
    '\trtcConf, err := rtc.NewWebRTCConfig(conf)\n' +
      '\tif err != nil {\n' +
      '\t\treturn nil, err\n' +
      '\t}\n\n' +
      '\tr := &RoomManager{',
    '\trtcConf, err := rtc.NewWebRTCConfig(conf)\n' +
      '\tif err != nil {\n' +
      '\t\treturn nil, err\n' +
      '\t}\n' +
      '\tivekitOwners, err := livekitowner.NewRegistryFromEnv()\n' +
      '\tif err != nil {\n' +
      '\t\treturn nil, err\n' +
      '\t}\n\n' +
      '\tr := &RoomManager{',
    'RoomManager owner construction'
  );
  next = replaceOnce(
    next,
    '\t\tforwardStats:      forwardStats,\n\n' +
      '\t\trooms: make(map[livekit.RoomName]*rtc.Room),',
    '\t\tforwardStats:      forwardStats,\n' +
      '\t\tivekitOwners:     ivekitOwners,\n\n' +
      '\t\trooms: make(map[livekit.RoomName]*rtc.Room),',
    'RoomManager owner assignment'
  );
  next = replaceOnce(
    next,
    '\tif err := r.whipServer.RegisterAllCommonTopics(currentNode.NodeID()); err != nil {\n' +
      '\t\treturn nil, err\n' +
      '\t}\n\n' +
      '\treturn r, nil',
    '\tif err := r.whipServer.RegisterAllCommonTopics(currentNode.NodeID()); err != nil {\n' +
      '\t\treturn nil, err\n' +
      '\t}\n' +
      '\tif err := r.ivekitOwners.Start(func(roomName string, ownerErr error) {\n' +
      '\t\troom := r.GetRoom(context.Background(), livekit.RoomName(roomName))\n' +
      '\t\tif room == nil {\n' +
      '\t\t\treturn\n' +
      '\t\t}\n' +
      '\t\troom.Logger().Errorw("ivekit room owner lost", ownerErr)\n' +
      '\t\troom.Close(types.ParticipantCloseReasonRoomManagerStop)\n' +
      '\t}); err != nil {\n' +
      '\t\treturn nil, err\n' +
      '\t}\n\n' +
      '\treturn r, nil',
    'owner refresh loop'
  );
  next = replaceOnce(
    next,
    'func (r *RoomManager) Stop() {\n' +
      '\t// disconnect all clients',
    'func (r *RoomManager) Stop() {\n' +
      '\tr.ivekitOwners.Stop()\n' +
      '\t// disconnect all clients',
    'owner refresh stop'
  );
  next = replaceOnce(
    next,
    '\tcreateRoom := pi.CreateRoom\n' +
      '\troom, err := r.getOrCreateRoom(ctx, createRoom)\n' +
      '\tif err != nil {',
    '\tcreateRoom := pi.CreateRoom\n' +
      '\townerOpened := false\n' +
      '\tif pi.Identity != "" {\n' +
      '\t\townerMetadata := ""\n' +
      '\t\tif pi.Grants != nil {\n' +
      '\t\t\townerMetadata = pi.Grants.Metadata\n' +
      '\t\t}\n' +
      '\t\topened, ownerErr := r.ivekitOwners.OpenOrAssert(\n' +
      '\t\t\tctx,\n' +
      '\t\t\tcreateRoom.Name,\n' +
      '\t\t\townerMetadata,\n' +
      '\t\t\tsessionStartTime,\n' +
      '\t\t)\n' +
      '\t\tif ownerErr != nil {\n' +
      '\t\t\treturn ownerErr\n' +
      '\t\t}\n' +
      '\t\townerOpened = opened\n' +
      '\t}\n' +
      '\troom, err := r.getOrCreateRoom(ctx, createRoom)\n' +
      '\tif err != nil {\n' +
      '\t\tif ownerOpened {\n' +
      '\t\t\t_ = r.ivekitOwners.Close(context.WithoutCancel(ctx), createRoom.Name)\n' +
      '\t\t}',
    'participant owner open'
  );
  next = replaceOnce(
    next,
    '\tnewRoom.OnClose(func() {\n' +
      '\t\tkillRoomServer()',
    '\tnewRoom.OnClose(func() {\n' +
      '\t\tif err := r.ivekitOwners.Close(\n' +
      '\t\t\tcontext.WithoutCancel(ctx),\n' +
      '\t\t\tstring(roomName),\n' +
      '\t\t); err != nil {\n' +
      '\t\t\tnewRoom.Logger().Errorw("could not close ivekit room owner", err)\n' +
      '\t\t}\n' +
      '\t\tkillRoomServer()',
    'room owner close'
  );
  next = replaceOnce(
    next,
    '\t\t\tif err := participant.HandleSignalMessage(obj); err != nil {',
    '\t\t\tif err := r.ivekitOwners.Assert(string(room.Name()), time.Now()); err != nil {\n' +
      '\t\t\t\t_ = participant.Close(true, types.ParticipantCloseReasonRoomManagerStop, false)\n' +
      '\t\t\t\treturn\n' +
      '\t\t\t}\n' +
      '\t\t\tif err := participant.HandleSignalMessage(obj); err != nil {',
    'signal owner assertion'
  );
  next = replaceOnce(
    next,
    '\tif room == nil {\n' +
      '\t\treturn nil, nil, ErrRoomNotFound\n' +
      '\t}\n\n' +
      '\tparticipant := room.GetParticipant(livekit.ParticipantIdentity(req.GetIdentity()))',
    '\tif room == nil {\n' +
      '\t\treturn nil, nil, ErrRoomNotFound\n' +
      '\t}\n' +
      '\tif err := r.ivekitOwners.Assert(req.GetRoom(), time.Now()); err != nil {\n' +
      '\t\treturn nil, nil, err\n' +
      '\t}\n\n' +
      '\tparticipant := room.GetParticipant(livekit.ParticipantIdentity(req.GetIdentity()))',
    'participant admin owner assertion'
  );
  next = replaceOnce(
    next,
    '\t} else {\n' +
      '\t\troom.Logger().Infow("deleting room")\n' +
      '\t\troom.Close(types.ParticipantCloseReasonServiceRequestDeleteRoom)',
    '\t} else {\n' +
      '\t\tif err := r.ivekitOwners.Assert(req.Room, time.Now()); err != nil {\n' +
      '\t\t\treturn nil, err\n' +
      '\t\t}\n' +
      '\t\troom.Logger().Infow("deleting room")\n' +
      '\t\troom.Close(types.ParticipantCloseReasonServiceRequestDeleteRoom)',
    'DeleteRoom owner assertion'
  );
  next = patchDirectRoomMutation(
    next,
    'SendData',
    'req.Room',
    'ErrRoomNotFound'
  );
  next = patchDirectRoomMutation(
    next,
    'UpdateRoomMetadata',
    'req.Room',
    'ErrRoomNotFound'
  );
  return next;
}

function liveKitRoomManagerOverlayState(source) {
  if (!source.includes('ivekitOwners')) return 'absent';

  const requiredFragments = [
    'livekitowner "ivekit.local/livekitowner"',
    'ivekitOwners *livekitowner.Registry',
    'livekitowner.NewRegistryFromEnv()',
    'ivekitOwners:',
    'r.ivekitOwners.Start(',
    'r.ivekitOwners.Stop()',
    'opened, ownerErr := r.ivekitOwners.OpenOrAssert(',
    'r.ivekitOwners.Assert(string(room.Name()), time.Now())',
    'r.ivekitOwners.Assert(req.GetRoom(), time.Now())',
    'could not close ivekit room owner'
  ];
  if (requiredFragments.some((fragment) => !source.includes(fragment))) {
    return 'partial';
  }
  if (countOccurrences(source, 'r.ivekitOwners.Assert(req.Room, time.Now())') !== 3) {
    return 'partial';
  }
  if (countOccurrences(source, 'r.ivekitOwners.Close(') !== 2) {
    return 'partial';
  }
  return 'complete';
}

function countOccurrences(source, fragment) {
  return source.split(fragment).length - 1;
}

function patchDirectRoomMutation(source, method, roomExpression, missingError) {
  const anchor =
    `func (r *RoomManager) ${method}(ctx context.Context, req ` +
    (method === 'SendData'
      ? '*livekit.SendDataRequest'
      : '*livekit.UpdateRoomMetadataRequest') +
    `) (` +
    (method === 'SendData'
      ? '*livekit.SendDataResponse'
      : '*livekit.Room') +
    `, error) {\n` +
    `\troom := r.GetRoom(ctx, livekit.RoomName(${roomExpression}))\n` +
    '\tif room == nil {\n' +
    `\t\treturn nil, ${missingError}\n` +
    '\t}';
  return replaceOnce(
    source,
    anchor,
    `${anchor}\n` +
      `\tif err := r.ivekitOwners.Assert(${roomExpression}, time.Now()); err != nil {\n` +
      '\t\treturn nil, err\n' +
      '\t}',
    `${method} owner assertion`
  );
}

export async function applyLiveKitOverlay(input) {
  const sourceDir = resolve(input.sourceDir);
  const repoRoot = resolve(input.repoRoot || defaultRepoRoot());
  const commit = execFileSync(
    'git',
    ['-C', sourceDir, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' }
  ).trim();
  if (commit !== LIVEKIT_UPSTREAM_COMMIT) {
    throw new Error(
      `LiveKit source commit mismatch: expected ${LIVEKIT_UPSTREAM_COMMIT}, got ${commit}`
    );
  }
  const exactTag = execFileSync(
    'git',
    ['-C', sourceDir, 'describe', '--tags', '--exact-match', 'HEAD'],
    { encoding: 'utf8' }
  ).trim();
  if (exactTag !== LIVEKIT_UPSTREAM_TAG) {
    throw new Error(
      `LiveKit source tag mismatch: expected ${LIVEKIT_UPSTREAM_TAG}, got ${exactTag}`
    );
  }

  const componentHookTarget = join(sourceDir, 'ivekit/component-hook-go');
  const ownerTarget = join(sourceDir, 'ivekit/livekit-owner');
  await mkdir(dirname(componentHookTarget), { recursive: true });
  await cp(
    join(repoRoot, 'integrations/component-hook-go'),
    componentHookTarget,
    { recursive: true, force: true }
  );
  await cp(
    join(repoRoot, 'integrations/livekit-v1.13.3'),
    ownerTarget,
    { recursive: true, force: true }
  );

  const goModPath = join(sourceDir, 'go.mod');
  const serverMainPath = join(sourceDir, 'cmd/server/main.go');
  const roomManagerPath = join(sourceDir, 'pkg/service/roommanager.go');
  await writeFile(
    goModPath,
    patchLiveKitGoMod(await readFile(goModPath, 'utf8')),
    'utf8'
  );
  await writeFile(
    serverMainPath,
    patchLiveKitServerMain(await readFile(serverMainPath, 'utf8')),
    'utf8'
  );
  await writeFile(
    roomManagerPath,
    patchLiveKitRoomManager(await readFile(roomManagerPath, 'utf8')),
    'utf8'
  );
  execFileSync(
    'gofmt',
    ['-w', serverMainPath, roomManagerPath],
    { stdio: 'inherit' }
  );
  const hotPathPatchStatus = applyPinnedPatch(
    sourceDir,
    join(
      repoRoot,
      'infra/ivekit/livekit/patches/livekit-ivekit-small-room-hot-path.patch'
    )
  );
  return {
    upstream_tag: LIVEKIT_UPSTREAM_TAG,
    upstream_commit: LIVEKIT_UPSTREAM_COMMIT,
    source_dir: sourceDir,
    hot_path_patch_status: hotPathPatchStatus
  };
}

function replaceOnce(source, anchor, replacement, label) {
  if (source.includes(replacement)) return source;
  const first = source.indexOf(anchor);
  const last = source.lastIndexOf(anchor);
  if (first < 0 || first !== last) {
    throw new Error(`LiveKit ${label} anchor mismatch`);
  }
  return source.slice(0, first) + replacement +
    source.slice(first + anchor.length);
}

function defaultRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const sourceDir = process.argv[2];
  if (!sourceDir) {
    console.error('usage: node apply-overlay.mjs <livekit-source-dir>');
    process.exitCode = 2;
  } else {
    applyLiveKitOverlay({ sourceDir }).then((result) => {
      console.log(JSON.stringify(result));
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
