import type { NetworkImpairmentLease } from './network-impairment.js';

export interface LiveKitNetworkNamespaceCommand {
  executable: '/sbin/ip' | '/usr/sbin/iptables';
  args: string[];
  ignore_failure?: boolean;
}

export interface LiveKitNetworkNamespacePlan {
  schema_version: '1.0.0';
  ordinal: number;
  namespace_name: string;
  host_interface_name: string;
  generator_interface_name: string;
  ifb_interface_name: string;
  host_address: string;
  generator_address: string;
  prefix_length: 30;
  livekit_url: string;
  setup: LiveKitNetworkNamespaceCommand[];
  restore: LiveKitNetworkNamespaceCommand[];
}

export interface LiveKitNetworkNamespaceAttestation {
  schema_version: '1.0.0';
  lease: NetworkImpairmentLease;
  observed_at: string;
  namespace_ordinal: number;
  livekit_port: number;
  namespace_name: string;
  host_interface_name: string;
  generator_interface_name: string;
  ifb_interface_name: string;
  host_address: string;
  generator_address: string;
  default_route_via: string;
}

export function buildLiveKitNetworkNamespacePlan(input: {
  ordinal: number;
  livekit_port: number;
}): LiveKitNetworkNamespacePlan {
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > 199) {
    throw new Error('LiveKit network namespace ordinal is invalid');
  }
  if (!Number.isInteger(input.livekit_port) ||
      input.livekit_port < 1 || input.livekit_port > 65_535) {
    throw new Error('LiveKit network namespace LiveKit port is invalid');
  }
  const suffix = String(input.ordinal);
  const namespaceName = `ivkgen${suffix}`;
  const hostInterface = `ivkh${suffix}`;
  const generatorInterface = `ivkn${suffix}`;
  const ifbInterface = `ivkifb${suffix}`;
  const thirdOctet = 24 + input.ordinal;
  const hostAddress = `10.203.${thirdOctet}.1`;
  const generatorAddress = `10.203.${thirdOctet}.2`;
  const firewallArgs = [
    '-i', hostInterface,
    '-p', 'tcp',
    '--dport', String(input.livekit_port),
    '-m', 'comment',
    '--comment', `ivekit-netns-${suffix}`,
    '-j', 'ACCEPT'
  ];
  const setup: LiveKitNetworkNamespaceCommand[] = [
    ip(['netns', 'add', namespaceName]),
    ip(['link', 'add', hostInterface, 'type', 'veth', 'peer', 'name', generatorInterface]),
    ip(['link', 'set', generatorInterface, 'netns', namespaceName]),
    ip(['address', 'add', `${hostAddress}/30`, 'dev', hostInterface]),
    ip(['link', 'set', hostInterface, 'up']),
    ip(['netns', 'exec', namespaceName, '/sbin/ip', 'link', 'set', 'lo', 'up']),
    ip([
      'netns', 'exec', namespaceName, '/sbin/ip',
      'address', 'add', `${generatorAddress}/30`, 'dev', generatorInterface
    ]),
    ip([
      'netns', 'exec', namespaceName, '/sbin/ip',
      'link', 'set', generatorInterface, 'up'
    ]),
    ip([
      'netns', 'exec', namespaceName, '/sbin/ip',
      'route', 'add', 'default', 'via', hostAddress
    ]),
    iptables(['-I', 'INPUT', '1', ...firewallArgs])
  ];
  return {
    schema_version: '1.0.0',
    ordinal: input.ordinal,
    namespace_name: namespaceName,
    host_interface_name: hostInterface,
    generator_interface_name: generatorInterface,
    ifb_interface_name: ifbInterface,
    host_address: hostAddress,
    generator_address: generatorAddress,
    prefix_length: 30,
    livekit_url: `ws://${hostAddress}:${input.livekit_port}`,
    setup,
    restore: [
      iptables(['-D', 'INPUT', ...firewallArgs], true),
      ip(['netns', 'del', namespaceName], true),
      ip(['link', 'del', hostInterface], true)
    ]
  };
}

export function buildLiveKitNetworkNamespaceAttestation(input: {
  plan: LiveKitNetworkNamespacePlan;
  lease: NetworkImpairmentLease;
  observed_at: string;
  host_interfaces: unknown;
  generator_interfaces: unknown;
  generator_routes: unknown;
}): LiveKitNetworkNamespaceAttestation {
  const observedAt = Date.parse(input.observed_at);
  if (!Number.isFinite(observedAt) ||
      new Date(observedAt).toISOString() !== input.observed_at) {
    throw new Error('LiveKit network namespace observation timestamp is invalid');
  }
  const livekitPort = Number(new URL(input.plan.livekit_url).port);
  requireAddress(
    input.host_interfaces,
    input.plan.host_interface_name,
    input.plan.host_address,
    input.plan.prefix_length,
    'host'
  );
  requireAddress(
    input.generator_interfaces,
    input.plan.generator_interface_name,
    input.plan.generator_address,
    input.plan.prefix_length,
    'generator'
  );
  requireDefaultRoute(
    input.generator_routes,
    input.plan.generator_interface_name,
    input.plan.host_address
  );
  return {
    schema_version: '1.0.0',
    lease: structuredClone(input.lease),
    observed_at: input.observed_at,
    namespace_ordinal: input.plan.ordinal,
    livekit_port: livekitPort,
    namespace_name: input.plan.namespace_name,
    host_interface_name: input.plan.host_interface_name,
    generator_interface_name: input.plan.generator_interface_name,
    ifb_interface_name: input.plan.ifb_interface_name,
    host_address: `${input.plan.host_address}/${input.plan.prefix_length}`,
    generator_address: `${input.plan.generator_address}/${input.plan.prefix_length}`,
    default_route_via: input.plan.host_address
  };
}

function requireAddress(
  observations: unknown,
  interfaceName: string,
  address: string,
  prefixLength: number,
  label: string
): void {
  if (!Array.isArray(observations)) {
    throw new Error(`LiveKit network namespace ${label} interface observation is invalid`);
  }
  const matched = observations.some((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const value = candidate as Record<string, unknown>;
    if (value.ifname !== interfaceName || !Array.isArray(value.addr_info)) return false;
    return value.addr_info.some((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const addressValue = entry as Record<string, unknown>;
      return addressValue.family === 'inet' &&
        addressValue.local === address &&
        addressValue.prefixlen === prefixLength;
    });
  });
  if (!matched) {
    throw new Error(`LiveKit network namespace ${label} interface address is invalid`);
  }
}

function requireDefaultRoute(
  observations: unknown,
  interfaceName: string,
  gateway: string
): void {
  if (!Array.isArray(observations) || !observations.some((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const value = candidate as Record<string, unknown>;
    return value.dst === 'default' && value.gateway === gateway && value.dev === interfaceName;
  })) {
    throw new Error('LiveKit network namespace default route is invalid');
  }
}

function ip(
  args: string[],
  ignoreFailure = false
): LiveKitNetworkNamespaceCommand {
  return command('/sbin/ip', args, ignoreFailure);
}

function iptables(
  args: string[],
  ignoreFailure = false
): LiveKitNetworkNamespaceCommand {
  return command('/usr/sbin/iptables', args, ignoreFailure);
}

function command(
  executable: LiveKitNetworkNamespaceCommand['executable'],
  args: string[],
  ignoreFailure: boolean
): LiveKitNetworkNamespaceCommand {
  return {
    executable,
    args,
    ...(ignoreFailure ? { ignore_failure: true } : {})
  };
}
