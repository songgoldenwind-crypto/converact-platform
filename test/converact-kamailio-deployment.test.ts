import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const chartRoot = 'services/converact-service/helm/converact';

function read(path: string): string {
  return readFileSync(`${chartRoot}/${path}`, 'utf8');
}

test('Helm defaults model one production Cell Zone with bounded RustPBX and Kamailio pools', () => {
  const values = parse(read('values.yaml')) as any;

  assert.equal(values.voice.replicaCount >= 2, true);
  assert.equal(values.voice.network.hostNetwork, true);
  assert.equal(values.voice.componentNode.enabled, true);
  assert.equal(values.voice.kamailio.enabled, true);
  assert.equal(values.voice.kamailio.replicaCount >= 2, true);
  assert.equal(values.voice.kamailio.image.repository.length > 0, true);
  assert.equal(values.voice.kamailio.image.digest, '');
  assert.equal(values.voice.kamailio.cellLeaseEpoch, 1);
  assert.equal(values.voice.kamailio.runtime.sharedMemoryAllocator, 'fm');
  assert.equal(values.voice.kamailio.runtime.sharedMemoryMegabytes, 512);
  assert.equal(values.voice.kamailio.runtime.privateMemoryMegabytes, 32);
  assert.equal(values.voice.kamailio.routeAgent.edgeReplicaCount, values.voice.kamailio.replicaCount);
  assert.equal(values.voice.kamailio.routeAgent.snapshotTtlMs <= 10_000, true);
  assert.equal(values.voice.kamailio.routeAgent.pollIntervalMs <= 1_000, true);
  assert.equal(values.voice.kamailio.service.externalTrafficPolicy, 'Local');
  assert.equal(values.voice.kamailio.service.sessionAffinity, 'ClientIP');
  assert.equal(values.voice.kamailio.networkPolicy.enabled, true);
  assert.deepEqual(values.voice.kamailio.networkPolicy.rustpbxNodeCidrs, ['10.0.0.0/8']);
  assert.deepEqual(values.voice.kamailio.rustpbxSourceCidrs, ['10.0.0.0/8']);
  assert.deepEqual(values.voice.kamailio.dmqSourceCidrs, ['10.0.0.0/8']);
  assert.equal(values.voice.kamailio.dmq.enabled, true);
  assert.equal(values.voice.kamailio.sipTrace.enabled, false);
  assert.equal(values.voice.kamailio.sipTrace.collectorPort, 9060);
  assert.equal(values.voice.kamailio.sipTrace.metricsPort, 9090);
  assert.equal(values.voice.kamailio.sipTrace.highWater.enabled, true);
  assert.equal(values.voice.kamailio.sipTrace.highWater.samplePercent, 10);
  assert.equal(
    values.voice.kamailio.sipTrace.highWater.queueRecoverRatio <
      values.voice.kamailio.sipTrace.highWater.queueSampleRatio,
    true
  );
  assert.equal(
    values.voice.kamailio.sipTrace.highWater.queueSampleRatio <
      values.voice.kamailio.sipTrace.highWater.queueOffRatio,
    true
  );
  assert.deepEqual(values.voice.kamailio.networkPolicy.hepCollectorCidrs, []);
  assert.deepEqual(values.voice.kamailio.networkPolicy.hepCollectorNamespaceSelector, {});
  assert.deepEqual(values.voice.kamailio.networkPolicy.hepCollectorPodSelector, {
    'app.kubernetes.io/component': 'homer'
  });
  assert.equal(values.voice.kamailio.listeners.dmqPort, 5066);
  assert.equal(values.voice.kamailio.dmq.syncMessageContacts <= 150, true);
  assert.deepEqual(values.voice.service, undefined);
});

test('RustPBX deploys as a stable host-networked node pool without public SIP or RTP Services', () => {
  const template = read('templates/rustpbx-deployment.yaml');

  assert.match(template, /kind: StatefulSet/);
  assert.match(template, /serviceName:.*rustpbxHeadlessFullname/);
  assert.match(template, /replicas:.*voice\.replicaCount/);
  assert.match(template, /podManagementPolicy: Parallel/);
  assert.match(template, /updateStrategy:[\s\S]*type: RollingUpdate/);
  assert.match(template, /hostNetwork:.*voice\.network\.hostNetwork/);
  assert.match(template, /dnsPolicy: ClusterFirstWithHostNet/);
  assert.match(template, /topologySpreadConstraints:/);
  assert.match(template, /podAntiAffinity:/);
  assert.match(template, /fieldPath: metadata\.name/);
  assert.match(template, /fieldPath: status\.hostIP/);
  assert.match(template, /POST \/v1\/drain/);
  assert.match(template, /terminationGracePeriodSeconds/);
  assert.match(template, /volumeClaimTemplates:/);
  assert.match(template, /clusterIP: None/);
  assert.match(template, /publishNotReadyAddresses: true/);
  assert.doesNotMatch(template, /rustpbx-sip|rustpbx-rtp|type: LoadBalancer/);
});

test('Kamailio Helm workload renders immutable config and runs route agent beside a hardened edge', () => {
  const files = [
    'templates/kamailio-config.yaml',
    'templates/kamailio-deployment.yaml',
    'templates/kamailio-network-policy.yaml'
  ];
  for (const file of files) assert.equal(existsSync(`${chartRoot}/${file}`), true, file);

  const config = read(files[0]!);
  const deployment = read(files[1]!);
  const policy = read(files[2]!);

  assert.match(config, /kamailio-runtime\.json/);
  assert.match(config, /kamailio-topology\.json/);
  assert.match(config, /capacity_dimension/);
  assert.match(config, /component_endpoint/);
  assert.match(config, /service_token_file/);
  assert.match(config, /pin_set_id/);
  assert.match(config, /rustpbxHeadlessFullname/);
  assert.match(config, /rustpbx_source_cidrs/);
  assert.match(config, /dmq_source_cidrs/);
  assert.match(config, /webphone_auth/);
  assert.match(config, /jwt_secret_file/);
  assert.match(config, /allowed_origins/);
  assert.match(config, /notification_address/);
  assert.match(config, /sip:%s-0\.%s-dmq/);
  assert.match(config, /"sip_trace"/);
  assert.match(config, /collector_host/);
  assert.match(config, /requires a HEP collector namespace\/pod selector or narrow collector CIDRs/);
  assert.match(config, /hepCollectorCidrs must not contain a default route/);
  assert.match(config, /sipTrace\.highWater\.enabled/);
  assert.match(config, /sipTrace\.metricsPort/);
  assert.match(config, /sipTrace requires highWater\.enabled/);
  assert.match(config, /sipTrace requires networkPolicy\.enabled/);
  assert.match(config, /initial_mode/);

  assert.match(deployment, /kind: StatefulSet/);
  assert.match(deployment, /serviceName:.*-dmq/);
  assert.match(deployment, /podManagementPolicy: Parallel/);
  assert.match(deployment, /replicas:.*kamailio\.replicaCount/);
  assert.match(deployment, /name: render-config[\s\S]*converact-render-kamailio-config\.js/);
  assert.match(deployment, /name: route-agent[\s\S]*converact-kamailio-route-agent\.js/);
  assert.match(deployment, /name: kamailio[\s\S]*kamailio\.image/);
  assert.match(
    deployment,
    /args:[\s\S]*"-x"[\s\S]*sharedMemoryAllocator[\s\S]*"-m"[\s\S]*sharedMemoryMegabytes[\s\S]*"-M"[\s\S]*privateMemoryMegabytes/
  );
  assert.match(deployment, /CONVERACT_FABRIC_KAMAILIO_RPC_ENDPOINT[\s\S]*127\.0\.0\.1:%v\/RPC[\s\S]*listeners\.rpcPort/);
  assert.match(deployment, /CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_ENABLED/);
  assert.match(deployment, /CONVERACT_FABRIC_KAMAILIO_HOMER_METRICS_ENDPOINT/);
  assert.match(deployment, /CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_PROCESSING_GAP_OFF_PER_SECOND/);
  assert.match(deployment, /CONVERACT_FABRIC_KAMAILIO_HOST[\s\S]*0\.0\.0\.0/);
  assert.match(deployment, /CONVERACT_FABRIC_KAMAILIO_WEBPHONE_JWT_SECRET_FILE/);
  assert.match(deployment, /CONVERACT_FABRIC_KAMAILIO_DMQ_SERVER_HOST[\s\S]*fieldPath: status\.podIP/);
  assert.match(deployment, /webphone-jwt-secret/);
  assert.match(deployment, /projected:/);
  assert.match(deployment, /readinessProbe:/);
  assert.match(deployment, /livenessProbe:/);
  assert.match(deployment, /topologySpreadConstraints:/);
  assert.match(deployment, /podAntiAffinity:/);
  assert.match(deployment, /kind: PodDisruptionBudget/);
  assert.match(deployment, /minAvailable:/);
  assert.match(deployment, /name:.*-dmq/);
  assert.match(deployment, /clusterIP: None/);
  assert.match(deployment, /publishNotReadyAddresses: true/);
  assert.match(deployment, /name: dmq-udp[\s\S]*listeners\.dmqPort/);

  assert.match(policy, /kind: NetworkPolicy/);
  assert.match(policy, /policyTypes:[\s\S]*Ingress[\s\S]*Egress/);
  assert.match(policy, /rustpbxNodeCidrs/);
  assert.match(policy, /app\.kubernetes\.io\/component: kamailio/);
  assert.match(policy, /listeners\.dmqPort/);
  assert.match(policy, /sipTrace\.enabled/);
  assert.match(policy, /hepCollectorCidrs/);
  assert.match(policy, /hepCollectorNamespaceSelector/);
  assert.match(policy, /hepCollectorPodSelector/);
  assert.match(policy, /sipTrace\.collectorPort/);
  assert.match(policy, /sipTrace\.metricsPort/);
  assert.match(policy, /sipTrace\.highWater\.enabled/);
  assert.match(
    policy,
    /ingress:[\s\S]*?app\.kubernetes\.io\/component: kamailio[\s\S]*?listeners\.dmqPort[\s\S]*?protocol: UDP[\s\S]*?egress:/
  );
  assert.match(policy, /ipBlock:[\s\S]*cidr:/);
  assert.doesNotMatch(policy, /port: 5065/);
});

test('Kamailio publishes only SIP transports while metrics remain cluster internal', () => {
  const deployment = read('templates/kamailio-deployment.yaml');

  assert.match(deployment, /name: sip-udp[\s\S]*protocol: UDP/);
  assert.match(deployment, /name: sip-tcp[\s\S]*protocol: TCP/);
  assert.match(deployment, /name: sip-tls[\s\S]*protocol: TCP/);
  assert.match(deployment, /name: sip-wss[\s\S]*protocol: TCP/);
  assert.match(deployment, /name: dmq-udp[\s\S]*protocol: UDP/);
  assert.match(deployment, /name: route-metrics[\s\S]*type: ClusterIP/);
  assert.match(deployment, /externalTrafficPolicy:.*externalTrafficPolicy/);
  assert.match(deployment, /sessionAffinity:.*sessionAffinity/);
  assert.doesNotMatch(deployment, /name: rpc[\s\S]{0,120}(?:port|targetPort): 5065/);
});

test('Kamailio route health is scraped and failure domains have actionable alerts', () => {
  const monitor = read('templates/service-monitor.yaml');
  const rules = read('files/prometheus-rules.yaml');

  assert.match(monitor, /name:.*kamailio/);
  assert.match(monitor, /app\.kubernetes\.io\/component: kamailio/);
  assert.match(monitor, /port: route-metrics/);
  assert.match(monitor, /path: \/metrics/);
  for (const alert of [
    'ConveractFabricKamailioSnapshotExpired',
    'ConveractFabricKamailioCoreMetricsUnavailable',
    'ConveractFabricKamailioNoAvailableRustPbx',
    'ConveractFabricKamailioMajorityDestinationsDown',
    'ConveractFabricKamailioRouteReloadFailure',
    'ConveractFabricKamailioHepCollectorUnavailable',
    'ConveractFabricKamailioHepControlFailure',
    'ConveractFabricKamailioHepControlPending',
    'ConveractFabricKamailioHepTraceDisabled',
    'ConveractFabricKamailioFailoverExhausted',
    'ConveractFabricKamailioDialogPinFailure',
    'ConveractFabricKamailioWebPhoneAuthFailures',
    'ConveractFabricKamailioWebPhoneLocationSaveFailure',
    'ConveractFabricKamailioDmqRejected'
  ]) assert.match(rules, new RegExp(`alert: ${alert}`));
});
