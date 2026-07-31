import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hotfixRoot = join(
  repositoryRoot,
  'infra',
  'hotfixes',
  'production-media-20260730'
);

const LIVEKIT_IMAGE_ID =
  'sha256:95b4473a03aeba9d2c36c62450f1bc924ad0638a44a9edd4cae46860aed23963';
const CAPACITY_IMAGE_ID =
  'sha256:83296c08de7b798cdb753527d216efd5b7dc1ef6ec8a05c1233f16a4f9feece3';

test('hotfix pins the retained owner binaries and cannot pull replacements', () => {
  const env = read('env.example');
  const api = read('api-hotfix.override.yml');
  const cell = read('cell-owner.override.yml');
  const livekit = read('livekit-owner.override.yml');

  assert.match(env, new RegExp(
    `^LIVEKIT_SERVER_IMAGE_ID=${escapeRegex(LIVEKIT_IMAGE_ID)}$`,
    'm'
  ));
  assert.match(env, new RegExp(
    `^IVEKIT_CAPACITY_TOOLS_IMAGE_ID=${escapeRegex(CAPACITY_IMAGE_ID)}$`,
    'm'
  ));
  assert.match(
    env,
    new RegExp(
      '^LIVEKIT_SERVER_IMAGE=ivekit/livekit-server@' +
      escapeRegex(LIVEKIT_IMAGE_ID) +
      '$',
      'm'
    )
  );
  assert.match(
    env,
    new RegExp(
      '^IVEKIT_CAPACITY_TOOLS_IMAGE=ivekit/opc@' +
      escapeRegex(CAPACITY_IMAGE_ID) +
      '$',
      'm'
    )
  );
  for (const source of [api, cell, livekit]) {
    for (const imageService of serviceBlocksWithImage(source)) {
      assert.match(imageService, /pull_policy:\s*never/);
    }
  }
  for (const source of [api, cell]) {
    for (const imageService of serviceBlocksWithImage(source)) {
      assert.match(imageService, /build:\s*!reset\s+null/);
    }
  }
});

test('create rollout is fail-closed and canary admission remains exact', () => {
  const env = read('env.example');
  const api = serviceBlock(read('api-hotfix.override.yml'), 'opc');
  for (const line of [
    'OPC_IVEKIT_MEDIA_CALL_CREATE_FREEZE=1',
    'OPC_IVEKIT_MEDIA_CALL_CREATE_FREEZE_RULE_ID=production-media-20260730',
    'OPC_IVEKIT_MEDIA_CALL_CREATE_CANARY_TENANT_IDS=',
    'OPC_IVEKIT_MEDIA_CALL_CREATE_CANARY_SUBJECTS=',
    'OPC_IVEKIT_MEDIA_CALL_CREATE_REQUIRE_PLACEMENT=1'
  ]) {
    assert.match(env, new RegExp(`^${escapeRegex(line)}$`, 'm'));
  }
  for (const variable of [
    'OPC_IVEKIT_MEDIA_CALL_CREATE_FREEZE',
    'OPC_IVEKIT_MEDIA_CALL_CREATE_FREEZE_RULE_ID',
    'OPC_IVEKIT_MEDIA_CALL_CREATE_CANARY_TENANT_IDS',
    'OPC_IVEKIT_MEDIA_CALL_CREATE_CANARY_SUBJECTS',
    'OPC_IVEKIT_MEDIA_CALL_CREATE_REQUIRE_PLACEMENT'
  ]) {
    assert.match(api, new RegExp(`^\\s+${variable}:`, 'm'));
  }
});

test('component owner is bounded and the release payload is an exact allowlist', () => {
  const component = serviceBlock(
    read('livekit-owner.override.yml'),
    'livekit-component-node'
  );
  assert.match(component, /pids_limit:\s*128/);
  assert.match(component, /mem_limit:\s*256m/);

  const payloadPaths = read('payload.paths')
    .trim()
    .split('\n');
  assert.equal(payloadPaths.length, 13);
  assert.deepEqual(payloadPaths, [...payloadPaths].sort());
  assert.equal(new Set(payloadPaths).size, payloadPaths.length);
  assert.deepEqual(payloadPaths, dockerfileCopySources(read('Dockerfile.opc')).sort());

  const env = read('env.example');
  for (const variable of [
    'IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_SHA256',
    'IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_SHA256',
    'IVEKIT_OPC_HOTFIX_PATCH_SHA256'
  ]) {
    assert.match(env, new RegExp(`^${variable}=[a-f0-9]{64}$`, 'm'));
  }
  for (const label of [
    'io.ivekit.hotfix.base-payload-manifest-sha256',
    'io.ivekit.hotfix.payload-manifest-sha256',
    'io.ivekit.hotfix.patch-sha256',
    'io.ivekit.hotfix.payload-file-count'
  ]) {
    assert.match(read('Dockerfile.opc'), new RegExp(escapeRegex(label)));
  }
});

test('runbook makes deployment, acceptance, expiry and rollback independently auditable', () => {
  const runbook = read('runbook.md');
  for (const expected of [
    '--file "$HOTFIX_ROOT/Dockerfile.opc"',
    '--pull never',
    'payload.paths',
    'base-payload.sha256',
    'hotfix-payload.sha256',
    'guarded migration runner',
    'two independent authenticated browser sessions',
    'different payload with the same Idempotency-Key',
    'HTTP 409',
    'bytesSent',
    'bytesReceived',
    'active Call = 0',
    'placement = 0',
    'reservation = 0',
    'room = 0',
    'database restore point',
    'clock synchronized',
    'expiry alert',
    'Phase 0',
    'Phase 1',
    '--profile voice-capacity',
    'base-only rollback',
    'omit every hotfix override'
  ]) {
    assert.match(runbook, new RegExp(escapeRegex(expected), 'i'));
  }
  assert.doesNotMatch(
    runbook,
    /\$RELEASE_CONTEXT\/\$HOTFIX_ROOT\/Dockerfile\.opc/
  );
});

test('retained host-network LiveKit reaches the owner only through host loopback', async () => {
  const livekitOverride = serviceBlock(
    read('livekit-owner.override.yml'),
    'livekit'
  );
  assert.doesNotMatch(livekitOverride, /^\s+networks:/m);
  assert.match(
    livekitOverride,
    /IVEKIT_COMPONENT_NODE_ENDPOINT:\s+http:\/\/127\.0\.0\.1:3210/
  );

  const validator = await import(
    pathToFileURL(join(hotfixRoot, 'validate.mjs')).href
  ) as {
    validateRenderedComposeContracts: (input: unknown) => void;
  };
  const opcImage = 'ivekit/opc:production-media-20260730-aaaaaaaaaaaa';
  const capacityImage = `ivekit/opc@${CAPACITY_IMAGE_ID}`;
  const liveKitImage = `ivekit/livekit-server@${LIVEKIT_IMAGE_ID}`;
  const liveKitNode = {
    node_id: 'livekit-owner-hotfix-20260730',
    endpoint: 'https://livekit.example.com',
    control_endpoint: 'http://livekit-component-node:3210',
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['livekit_av']
  };
  const baseService = (image: string, extra = {}) => ({
    image,
    volumes: [],
    networks: { default: {} },
    ...extra
  });
  const hotfixService = (image: string, extra = {}) => ({
    image,
    pull_policy: 'never',
    volumes: [],
    networks: { default: {} },
    ...extra
  });
  const input = {
    opcImage,
    capacityImage,
    liveKitImage,
    liveKitNode,
    apiBase: {
      services: {
        opc: baseService('old-opc'),
        'postgres-migrate': baseService('old-opc')
      },
      networks: { default: {} },
      volumes: {}
    },
    api: {
      services: {
        opc: hotfixService(opcImage),
        'postgres-migrate': hotfixService(opcImage)
      },
      networks: { default: {} },
      volumes: {}
    },
    cellBase: {
      services: {
        'cell-admission': baseService('old-capacity'),
        'rustpbx-capacity-projector': baseService('old-capacity'),
        'rustpbx-placement-snapshot-projector': baseService('old-capacity')
      },
      networks: { default: {} },
      volumes: {}
    },
    cell: {
      services: {
        'cell-admission': hotfixService(capacityImage, {
          networks: { default: {}, 'ivekit-owner-control': {} },
          environment: {
            OPC_IVEKIT_CELL_NODES_JSON: JSON.stringify([liveKitNode])
          }
        }),
        'rustpbx-capacity-projector': hotfixService(capacityImage, {
          networks: { default: {}, 'ivekit-owner-control': {} }
        }),
        'rustpbx-placement-snapshot-projector': hotfixService(capacityImage)
      },
      networks: { default: {}, 'ivekit-owner-control': {} },
      volumes: {}
    },
    liveKitBase: {
      services: {
        livekit: {
          image: 'old-livekit',
          network_mode: 'host',
          volumes: []
        }
      },
      networks: {},
      volumes: {}
    },
    liveKit: {
      services: {
        livekit: {
          image: liveKitImage,
          pull_policy: 'never',
          network_mode: 'host',
          volumes: [],
          environment: {
            IVEKIT_COMPONENT_NODE_ENDPOINT: 'http://127.0.0.1:3210'
          }
        },
        'livekit-component-node': {
          image: capacityImage,
          pull_policy: 'never',
          pids_limit: 128,
          mem_limit: '256m',
          networks: {
            'ivekit-owner-control': {},
            'ivekit-owner-loopback': { gw_priority: 1 }
          }
        }
      },
      networks: {
        'ivekit-owner-control': {},
        'ivekit-owner-loopback': {}
      },
      volumes: {}
    }
  };

  assert.doesNotThrow(() =>
    validator.validateRenderedComposeContracts(input)
  );
  assert.throws(
    () => validator.validateRenderedComposeContracts({
      ...input,
      liveKit: {
        ...input.liveKit,
        services: {
          ...input.liveKit.services,
          livekit: {
            ...input.liveKit.services.livekit,
            network_mode: undefined,
            networks: { 'ivekit-owner-control': {} }
          }
        }
      }
    }),
    /network mode/
  );
  assert.throws(
    () => validator.validateRenderedComposeContracts({
      ...input,
      api: {
        ...input.api,
        services: {
          ...input.api.services,
          opc: {
            ...input.api.services.opc,
            build: { context: '.' }
          }
        }
      }
    }),
    /build/
  );
  assert.throws(
    () => validator.validateRenderedComposeContracts({
      ...input,
      cell: {
        ...input.cell,
        services: {
          ...input.cell.services,
          'cell-admission': {
            ...input.cell.services['cell-admission'],
            environment: {
              OPC_IVEKIT_CELL_NODES_JSON: JSON.stringify([{
                ...liveKitNode,
                endpoint: 'wss://livekit.example.com'
              }])
            }
          }
        }
      }
    }),
    /rendered LiveKit node/
  );
});

test('validator rejects a retagged binary and ambiguous control networking', async () => {
  const validator = await import(
    pathToFileURL(join(hotfixRoot, 'validate.mjs')).href
  ) as {
    validateExactDigestImageInspect: (
      inspect: unknown,
      expectedImage: string,
      expectedImageId: string,
      label: string
    ) => void;
    validateControlNetworkRuntime: (
      controlNetworkInspect: unknown,
      loopbackNetworkInspect: unknown,
      containerInspects: unknown,
      expected: {
        network: string;
        loopbackNetwork: string;
        componentContainer: string;
        alias: string;
        hostPort: string;
      }
    ) => void;
    validatePayloadManifest: (
      source: string,
      expectedPaths: string[],
      options?: { allowAbsent?: boolean }
    ) => void;
  };

  const livekitRef = `ivekit/livekit-server@${LIVEKIT_IMAGE_ID}`;
  validator.validateExactDigestImageInspect({
    Id: LIVEKIT_IMAGE_ID,
    RepoDigests: [livekitRef],
    Config: { Labels: {} }
  }, livekitRef, LIVEKIT_IMAGE_ID, 'LiveKit');
  assert.throws(
    () => validator.validateExactDigestImageInspect({
      Id: `sha256:${'f'.repeat(64)}`,
      RepoDigests: [livekitRef],
      Config: { Labels: {} }
    }, livekitRef, LIVEKIT_IMAGE_ID, 'LiveKit'),
    /image ID/
  );

  const network = [{
    Name: 'ivekit-owner-control',
    Internal: true,
    Containers: {
      component: {
        Name: 'opc-ivekit-media-livekit-component-node-1',
        IPv4Address: '172.29.0.2/16'
      },
      cell: {
        Name: 'ivekit-goal3-0f9b063-cell-admission-1',
        IPv4Address: '172.29.0.3/16'
      }
    }
  }];
  const componentInspect = [{
    Name: '/opc-ivekit-media-livekit-component-node-1',
    HostConfig: {
      PortBindings: {
        '3210/tcp': [{ HostIp: '127.0.0.1', HostPort: '3210' }]
      }
    },
    NetworkSettings: {
      Ports: {
        '3210/tcp': [{ HostIp: '127.0.0.1', HostPort: '3210' }]
      },
      Networks: {
        'ivekit-owner-control': {
          Aliases: [
            'opc-ivekit-media-livekit-component-node-1',
            'livekit-component-node'
          ],
          IPAddress: '172.29.0.2'
        },
        'ivekit-owner-loopback': {
          Aliases: ['opc-ivekit-media-livekit-component-node-1'],
          IPAddress: '172.30.0.2'
        }
      }
    }
  }];
  const cellInspect = [{
    Name: '/ivekit-goal3-0f9b063-cell-admission-1',
    HostConfig: { PortBindings: {} },
    NetworkSettings: {
      Networks: {
        'ivekit-owner-control': {
          Aliases: ['ivekit-goal3-0f9b063-cell-admission-1'],
          IPAddress: '172.29.0.3'
        }
      }
    }
  }];
  const loopbackNetwork = [{
    Name: 'ivekit-owner-loopback',
    Internal: false,
    Containers: {
      component: {
        Name: 'opc-ivekit-media-livekit-component-node-1',
        IPv4Address: '172.30.0.2/16'
      }
    }
  }];
  const expected = {
    network: 'ivekit-owner-control',
    loopbackNetwork: 'ivekit-owner-loopback',
    componentContainer: 'opc-ivekit-media-livekit-component-node-1',
    alias: 'livekit-component-node',
    hostPort: '3210'
  };
  validator.validateControlNetworkRuntime(
    network,
    loopbackNetwork,
    [componentInspect, cellInspect],
    expected
  );
  assert.throws(
    () => validator.validateControlNetworkRuntime(
      network,
      loopbackNetwork,
      [
        componentInspect,
        [{
          ...cellInspect[0],
          NetworkSettings: {
            Networks: {
              'ivekit-owner-control': {
                Aliases: ['livekit-component-node'],
                IPAddress: '172.29.0.3'
              }
            }
          }
        }]
      ],
      expected
    ),
    /alias/
  );

  validator.validatePayloadManifest(
    `${'a'.repeat(64)}  one\n${'b'.repeat(64)}  two\n`,
    ['one', 'two']
  );
  assert.throws(
    () => validator.validatePayloadManifest(
      `${'a'.repeat(64)}  one\n${'b'.repeat(64)}  extra\n`,
      ['one', 'two']
    ),
    /path allowlist/
  );
  validator.validatePayloadManifest(
    `ABSENT  one\n${'b'.repeat(64)}  two\n`,
    ['one', 'two'],
    { allowAbsent: true }
  );
  assert.throws(
    () => validator.validatePayloadManifest(
      `ABSENT  one\n${'b'.repeat(64)}  two\n`,
      ['one', 'two']
    ),
    /invalid entry/
  );
});

test('owner component separates Cell DNS from a one-member host loopback transport', async () => {
  const liveKitSource = read('livekit-owner.override.yml');
  const component = serviceBlock(liveKitSource, 'livekit-component-node');
  assert.match(
    component,
    /ivekit-owner-loopback:\s*\n\s+gw_priority:\s*1/
  );
  assert.match(
    liveKitSource,
    /ivekit-owner-loopback:\s*\n\s+external:\s*true\s*\n\s+name:\s*ivekit-owner-loopback/
  );

  const validator = await import(
    pathToFileURL(join(hotfixRoot, 'validate.mjs')).href
  ) as {
    validateControlNetworkRuntime: (
      controlNetworkInspect: unknown,
      loopbackNetworkInspect: unknown,
      containerInspects: unknown,
      expected: {
        network: string;
        loopbackNetwork: string;
        componentContainer: string;
        alias: string;
        hostPort: string;
      }
    ) => void;
  };
  const componentName = 'opc-ivekit-media-livekit-component-node-1';
  const controlNetwork = [{
    Name: 'ivekit-owner-control',
    Internal: true,
    Containers: {
      component: {
        Name: componentName,
        IPv4Address: '172.29.0.2/16'
      }
    }
  }];
  const loopbackNetwork = [{
    Name: 'ivekit-owner-loopback',
    Internal: false,
    Containers: {
      component: {
        Name: componentName,
        IPv4Address: '172.30.0.2/16'
      }
    }
  }];
  const componentInspect = [{
    Name: `/${componentName}`,
    HostConfig: {
      PortBindings: {
        '3210/tcp': [{ HostIp: '127.0.0.1', HostPort: '3210' }]
      }
    },
    NetworkSettings: {
      Ports: {
        '3210/tcp': [{ HostIp: '127.0.0.1', HostPort: '3210' }]
      },
      Networks: {
        'ivekit-owner-control': {
          Aliases: [componentName, 'livekit-component-node'],
          IPAddress: '172.29.0.2'
        },
        'ivekit-owner-loopback': {
          Aliases: [componentName],
          IPAddress: '172.30.0.2'
        }
      }
    }
  }];
  const expected = {
    network: 'ivekit-owner-control',
    loopbackNetwork: 'ivekit-owner-loopback',
    componentContainer: componentName,
    alias: 'livekit-component-node',
    hostPort: '3210'
  };

  assert.doesNotThrow(() =>
    validator.validateControlNetworkRuntime(
      controlNetwork,
      loopbackNetwork,
      [componentInspect],
      expected
    )
  );
  assert.throws(
    () => validator.validateControlNetworkRuntime(
      controlNetwork,
      loopbackNetwork,
      [{
        ...componentInspect[0],
        NetworkSettings: {
          ...componentInspect[0]!.NetworkSettings,
          Ports: { '3210/tcp': null }
        }
      }],
      expected
    ),
    /active loopback binding/
  );
  assert.throws(
    () => validator.validateControlNetworkRuntime(
      controlNetwork,
      [{
        ...loopbackNetwork[0],
        Containers: {
          ...loopbackNetwork[0]!.Containers,
          unrelated: {
            Name: 'unrelated-container',
            IPv4Address: '172.30.0.3/16'
          }
        }
      }],
      [componentInspect],
      expected
    ),
    /only the component container/
  );
});

function read(name: string): string {
  return readFileSync(join(hotfixRoot, name), 'utf8');
}

function serviceBlock(source: string, service: string): string {
  return source.match(
    new RegExp(
      `^  ${escapeRegex(service)}:\\n` +
      '([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:|^networks:|(?![\\s\\S]))',
      'm'
    )
  )?.[0] || '';
}

function serviceBlocksWithImage(source: string): string[] {
  return source
    .split(/(?=^  [a-zA-Z0-9_-]+:\n)/m)
    .filter((block) => /^\s{2}[a-zA-Z0-9_-]+:\n/m.test(block) &&
      /^\s+image:/m.test(block));
}

function dockerfileCopySources(source: string): string[] {
  return [...source.matchAll(/^COPY ([^\s]+) [^\n]+$/gm)]
    .map((match) => match[1]);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
