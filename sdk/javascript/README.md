# @converact/javascript-sdk

JavaScript/TypeScript SDK for the OPC AI Communication Platform.

## Installation

```bash
npm install @converact/javascript-sdk
```

## Quick Start

```typescript
import { OPCClient } from '@converact/javascript-sdk';

const client = new OPCClient({
  baseUrl: 'https://api.yourplatform.com',
  apiKey: 'your-api-key'
});

// Get dashboard stats
const dashboard = await client.getDashboard('tenant_123');

// Create outbound call
await client.createOutboundTask({
  tenant_id: 'tenant_123',
  phone_number: '+1234567890',
  channel: 'pstn_voice'
});

// Trigger QM evaluation
await client.triggerQmEvaluation('tenant_123', 'session_456');

// Ask knowledge base
const answer = await client.askKnowledgeBase('tenant_123', 'What is your return policy?');
```

## API Reference

See the full [OpenAPI documentation](../../docs/openapi.yaml).
