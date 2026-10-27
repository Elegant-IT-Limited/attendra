import { expect, test } from '@playwright/test';
import { openAs, signInAgain } from './session';

test('a manager invites several people at once; someone with a login accepts, gets both clinics, and is removed from one only', async ({ browser }) => {
  // three people and a handful of pages, each compiled on first use by next dev
  test.slow();
  const manager = await openAs(browser, 'manager');
  await manager.getByRole('link', { name: 'Team' }).click();
  await manager.getByRole('button', { name: 'Add people' }).click();
  const dialog = manager.getByRole('dialog', { name: 'Add people' });
  // the vet clinic's manager and Cedar Park's front desk already have logins; Nico is new
  await dialog.getByLabel('Emails').fill('manager@riverbend-demo.test, frontdesk@cedarpark-demo.test\nNico Park <nico@maple-demo.test>');
  await expect(dialog.getByTestId('person-row')).toHaveCount(3);
  await dialog.getByLabel('Role for manager@riverbend-demo.test').selectOption({ label: 'Front desk' });
  await dialog.getByLabel('Role for frontdesk@cedarpark-demo.test').selectOption({ label: 'Viewer' });
  await dialog.getByRole('button', { name: 'Add 3 people' }).click();

  // the same answer for every email; the demo sends no email, so only someone new gets a temporary password
  const sent = manager.getByRole('dialog', { name: 'Invites sent' });
  for (const email of ['manager@riverbend-demo.test', 'frontdesk@cedarpark-demo.test', 'nico@maple-demo.test']) {
    await expect(sent.getByText(`${email}: invite sent`)).toBeVisible();
  }
  await expect(sent.getByTestId('temporary-password')).toHaveCount(1);
  await sent.getByRole('button', { name: 'Done' }).click();

  // the two with a login wait for an answer; Cedar Park's is cancelled
  const waiting = manager.getByTestId('invitations');
  await expect(waiting.getByRole('row', { name: /manager@riverbend-demo\.test/ })).toBeVisible();
  await waiting.getByRole('button', { name: 'Cancel the invitation to frontdesk@cedarpark-demo.test' }).click();
  await expect(manager.getByText('Invitation cancelled.')).toBeVisible();
  await expect(waiting.getByRole('row', { name: /frontdesk@cedarpark-demo\.test/ })).toHaveCount(0);

  // Robin, at the vet clinic, sees the invitation in their own dashboard and accepts it
  const robin = await signInAgain(browser, 'Vet clinic manager');
  const banner = robin.getByTestId('invitation');
  await expect(banner).toContainText('Maple Street Family Medicine invited you to its team as Front desk.');
  await banner.getByRole('button', { name: 'Accept' }).click();
  await expect(robin.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  // the clinic switcher: the one open now first, then the vet clinic
  const switcher = robin.getByRole('button', { name: 'Maple Street Family Medicine, Front desk: switch clinic' });
  await switcher.click();
  await expect(robin.getByRole('menuitemradio')).toHaveText([/Maple Street Family Medicine/, /Riverbend Animal Hospital/]);
  await robin.keyboard.press('Escape');
  await expect(robin.getByTestId('invitation')).toHaveCount(0);

  // a second invitation, to Cedar Park's front desk, is declined
  await manager.getByRole('button', { name: 'Add people' }).click();
  await manager.getByRole('dialog', { name: 'Add people' }).getByLabel('Emails').fill('frontdesk@cedarpark-demo.test');
  await manager.getByRole('dialog', { name: 'Add people' }).getByRole('button', { name: 'Add to the team' }).click();
  await manager.getByRole('dialog', { name: 'Invites sent' }).getByRole('button', { name: 'Done' }).click();
  const casey = await signInAgain(browser, 'Cedar Park front desk');
  await casey.getByTestId('invitation').getByRole('button', { name: 'Decline' }).click();
  await expect(casey.getByTestId('invitation')).toHaveCount(0);
  await expect(casey.getByRole('button', { name: /switch clinic/ })).toHaveCount(0);

  // Maple removes Robin: the vet clinic stays theirs
  await manager.reload();
  await manager.getByRole('row', { name: /Robin \(practice manager\)/ }).getByRole('button', { name: 'Remove' }).click();
  await manager.getByRole('dialog', { name: /Remove Robin/ }).getByRole('button', { name: 'Remove' }).click();
  await expect(manager.getByText('Robin (practice manager) is off the team')).toBeVisible();
  await robin.goto('/');
  await expect(robin).toHaveURL(/\/c\/[^/]+$/);
  await expect(robin.getByText('Riverbend Animal Hospital').first()).toBeVisible();
  await expect(robin.getByRole('button', { name: /switch clinic/ })).toHaveCount(0);

  // every step is in the audit log
  await manager.getByRole('link', { name: 'Audit log' }).click();
  for (const line of ['Invited a person to the team, as front desk', 'Cancelled an invitation to the team', 'Accepted an invitation and joined the team', 'Declined an invitation to the team']) {
    await expect(manager.getByText(line).first()).toBeVisible();
  }
});
