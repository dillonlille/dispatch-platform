'use strict';

const ACTION_LABELS = Object.freeze({
  keep: 'Keep existing credentials',
  enroll: 'Enroll credentials',
  replace: 'Replace stored credentials',
  remove: 'Delete stored credentials',
});
const PROVIDER_LABELS = Object.freeze({ paycom: 'Paycom', 'amazon-logistics': 'Amazon Logistics' });

function shouldInteract(command, interaction) {
  return command.format !== 'json' && command.nonInteractive !== true
    && interaction && typeof interaction.available === 'function' && interaction.available();
}

function commandInput(command, preparation) {
  const { target, defaults } = preparation;
  return {
    provider: target.provider,
    profile: target.profile,
    credentialAction: command.removeSpecified ? 'remove' : command.replaceSpecified ? 'replace' : defaults.credentialAction,
    startBroker: defaults.startBroker,
    testAuthentication: command.removeSpecified ? false
      : command.testAuthenticationSpecified ? true : defaults.testAuthentication,
  };
}

function renderState(preparation) {
  const { target, state } = preparation;
  return [
    'DISPATCH — Authentication Setup',
    '',
    'Current state',
    '',
    `  Provider              ${target.provider}`,
    `  Profile               ${target.profile}`,
    `  Credential profile    ${state.profile.status.replaceAll('_', ' ')}`,
    `  Vault                 ${state.vault.status}${state.vault.verified ? ' / verified' : ''}`,
    `  Auth Broker           ${state.broker.status}${state.broker.managed ? ' / managed' : ''}`,
  ].join('\n');
}

function renderPlan(input) {
  return [
    '',
    'Setup plan',
    '',
    `  Provider              ${input.provider}`,
    `  Profile               ${input.profile}`,
    `  Credential action     ${ACTION_LABELS[input.credentialAction].toLowerCase()}`,
    `  Start Auth Broker     ${input.startBroker ? 'yes' : 'no'}`,
    `  Test authentication   ${input.testAuthentication ? 'yes' : 'no'}`,
    '',
    ...(input.credentialAction === 'remove' ? [
      'This permanently deletes the encrypted profile and clears its authentication-attempt state.',
      'Any active session is revoked when the managed Auth Broker stops.',
    ] : [
      'Credential values are entered only in the Auth Broker protected terminal helper.',
      'Dispatch does not receive those values.',
    ]),
  ].join('\n');
}

async function collectSetupAuthInput(command, interaction, preparation) {
  const input = commandInput(command, preparation);
  if (!shouldInteract(command, interaction)) {
    if (input.credentialAction === 'remove' && !command.confirmed) return { cancelled: true, input, interactive: false };
    return { cancelled: false, input, interactive: false };
  }

  interaction.write(renderState(preparation));
  interaction.write('');

  if (!command.replaceSpecified && !command.removeSpecified) {
    const available = preparation.capabilities.credentialActions.filter(item => item.available);
    if (available.length === 0) throw Object.assign(new Error('setup_action_unavailable'), { code: 'setup_action_unavailable' });
    if (available.some(item => !Object.hasOwn(ACTION_LABELS, item.id))) {
      throw Object.assign(new Error('setup_action_unavailable'), { code: 'setup_action_unavailable' });
    }
    if (available.length === 1) input.credentialAction = available[0].id;
    else {
      input.credentialAction = await interaction.select({
        message: 'How should Dispatch handle the credential profile?',
        options: available.map(item => ({ value: item.id, label: ACTION_LABELS[item.id] })),
        defaultValue: available.some(item => item.id === preparation.defaults.credentialAction)
          ? preparation.defaults.credentialAction : available[0].id,
      });
    }
  }

  if (input.credentialAction !== 'remove' && !command.testAuthenticationSpecified && preparation.capabilities.authenticationTest.available) {
    input.testAuthentication = (await interaction.select({
      message: `Test ${PROVIDER_LABELS[input.provider] || input.provider} authentication after setup?`,
      options: [
        { value: 'skip', label: 'Skip authentication test' },
        { value: 'test', label: 'Test authentication' },
      ],
      defaultValue: preparation.defaults.testAuthentication ? 'test' : 'skip',
    })) === 'test';
  }

  interaction.write(renderPlan(input));
  const confirmationMessage = input.credentialAction === 'remove'
    ? `Permanently delete authentication profile ${input.profile}?` : 'Continue with this setup plan?';
  if (!(await interaction.confirm({ message: confirmationMessage, defaultValue: input.credentialAction !== 'remove' }))) {
    return { cancelled: true, input, interactive: true };
  }
  interaction.write('');
  return { cancelled: false, input, interactive: true };
}

module.exports = {
  ACTION_LABELS, PROVIDER_LABELS, collectSetupAuthInput, commandInput, renderPlan, renderState, shouldInteract,
};
