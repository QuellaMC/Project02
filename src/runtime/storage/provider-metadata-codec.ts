import type {RoleModelProviderMetadata} from '../../role-model/index.ts';
import {
  optionalRecordString,
  throwMalformedRecord,
} from './codec-primitives.ts';
import {isRecord, requiredRecordString} from './layout-contract.ts';

export function optionalRoleModelProviderMetadataOption(value: unknown): {
  readonly providerMetadata?: RoleModelProviderMetadata;
} {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throwMalformedRecord('providerMetadata');
  }

  const provider = requiredRecordString(value, 'provider', 'malformed_record');

  if (provider !== 'nvidia') {
    throwMalformedRecord('providerMetadata.provider');
  }

  const model = optionalRecordString(value, 'model', 'malformed_record');
  const request = optionalProviderRequestMetadata(value['request']);
  const response = optionalProviderResponseMetadata(value['response']);
  const error = optionalProviderErrorMetadata(value['error']);

  return {
    providerMetadata: Object.freeze({
      provider,
      ...(model === undefined ? {} : {model}),
      ...(request === undefined ? {} : {request}),
      ...(response === undefined ? {} : {response}),
      ...(error === undefined ? {} : {error}),
    } satisfies RoleModelProviderMetadata),
  };
}

function optionalProviderRequestMetadata(
  value: unknown,
): RoleModelProviderMetadata['request'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throwMalformedRecord('providerMetadata.request');
  }

  const endpoint = optionalRecordString(value, 'endpoint', 'malformed_record');
  const messageCount = value['messageCount'];

  if (messageCount !== undefined && typeof messageCount !== 'number') {
    throwMalformedRecord('providerMetadata.request.messageCount');
  }

  return Object.freeze({
    ...(endpoint === undefined ? {} : {endpoint}),
    ...(messageCount === undefined ? {} : {messageCount}),
  });
}

function optionalProviderResponseMetadata(
  value: unknown,
): RoleModelProviderMetadata['response'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throwMalformedRecord('providerMetadata.response');
  }

  const status = value['status'];

  if (status !== undefined && typeof status !== 'number') {
    throwMalformedRecord('providerMetadata.response.status');
  }

  return Object.freeze({
    ...(status === undefined ? {} : {status}),
  });
}

function optionalProviderErrorMetadata(
  value: unknown,
): RoleModelProviderMetadata['error'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throwMalformedRecord('providerMetadata.error');
  }

  return Object.freeze({
    code: requiredRecordString(value, 'code', 'malformed_record'),
    message: requiredRecordString(value, 'message', 'malformed_record'),
  });
}
