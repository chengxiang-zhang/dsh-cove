/**
 * Whether the private network should come back on its own.
 *
 * The client starts with the network off: an account is what the *other* machines need,
 * and the machine in front of the user works without one. But a person who connected the
 * fleet once does not want to ask for it again every launch - the identity is already on
 * disk, so remembering the request costs a sign-in nobody has to repeat, while forgetting
 * it reads as "my login was lost".
 *
 * The remembered thing is the user's own last choice, not a default: it is written when a
 * link actually came up, cleared when they turn the network off, and absent (the ordinary
 * case) for anyone who never asked.
 *
 * @module anywhere-agent/fleet-intent
 */

/**
 * Whether the stored settings remember a fleet the user asked for.
 *
 * Only a literal `true` restores the network: an absent key is the ordinary
 * single-machine user, and a corrupt or older value must not start a dial-up.
 *
 * @param {unknown} settings the parsed settings file
 * @returns {boolean} whether the network should be restored
 */
export function fleetWanted(settings) {
  return Boolean(settings && typeof settings === 'object' && settings.fleetWanted === true);
}

/**
 * The settings with the user's fleet choice recorded.
 *
 * @param {unknown} settings the parsed settings file
 * @param {boolean} wanted the choice to record
 * @returns {object} the settings to write, other choices untouched
 */
export function withFleetIntent(settings, wanted) {
  const current = settings && typeof settings === 'object' ? settings : {};
  return { ...current, fleetWanted: wanted === true };
}
