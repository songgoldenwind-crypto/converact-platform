try {
  const image = requiredEnv('IVEKIT_RTPENGINE_IMAGE');
  if (!/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error(
      'IVEKIT_RTPENGINE_IMAGE must use an immutable sha256 digest'
    );
  }

  const runtimeMode = requiredEnv('IVEKIT_RTPENGINE_RUNTIME_MODE');
  if (runtimeMode !== 'userspace' && runtimeMode !== 'kernel') {
    throw new Error(
      'IVEKIT_RTPENGINE_RUNTIME_MODE must be userspace or kernel'
    );
  }

  const networkInterface = requiredEnv('IVEKIT_RTPENGINE_INTERFACE');
  if (networkInterface.length > 256 ||
      /[\0\r\n\s]/.test(networkInterface)) {
    throw new Error('IVEKIT_RTPENGINE_INTERFACE is invalid');
  }

  const minimum = integerEnv(
    'IVEKIT_RTPENGINE_PORT_MIN',
    1_024,
    65_534
  );
  const maximum = integerEnv(
    'IVEKIT_RTPENGINE_PORT_MAX',
    1_025,
    65_535
  );
  if (maximum <= minimum) {
    throw new Error('IVEKIT RTPengine media port range is invalid');
  }
  const processingMinimum = integerEnv(
    'IVEKIT_PROCESSING_MEDIA_RTP_PORT_START',
    1_024,
    65_534
  );
  const processingMaximum = integerEnv(
    'IVEKIT_PROCESSING_MEDIA_RTP_PORT_END',
    1_025,
    65_535
  );
  if (processingMaximum <= processingMinimum ||
      processingMinimum % 2 !== 0 ||
      processingMaximum % 2 !== 0) {
    throw new Error('IVEKIT processing media port range is invalid');
  }
  if (processingMinimum <= maximum && processingMaximum >= minimum) {
    throw new Error(
      'IVEKIT processing media ports must not overlap RTPengine ports'
    );
  }

  process.stdout.write(
    `ivekit RTPengine deployment preflight passed mode=${runtimeMode} ` +
    `ports=${minimum}-${maximum} ` +
    `processing_ports=${processingMinimum}-${processingMaximum}\n`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message.replace(/[\0\r\n]/g, ' ')}\n`);
  process.exitCode = 78;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(
  name: string,
  minimum: number,
  maximum: number
): number {
  const value = Number(requiredEnv(name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}
