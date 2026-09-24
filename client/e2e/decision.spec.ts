import { test, expect } from '@playwright/test'
import { dismissSystemNotices } from './helpers'

// VS-14 — the decision-room golden path, end to end:
//   host opens a room from the dashboard → mints an invite link → an anonymous
//   participant joins on /d/<token> (no login) → both sides see a candidate →
//   host resolves → participant polls into the result → host locks a venue.
test('group decision: create → invite → join → resolve → select', async ({ page, browser }) => {
  await page.goto('/dashboard')
  await dismissSystemNotices(page)
  // The release-note overlay (.rn-overlay) is a second greeter with its own
  // close button — dismissSystemNotices only pages the dialog-shaped notices.
  await page.locator('.rn-overlay .rn-close').click().catch(() => {})
  await expect(page.locator('.rn-overlay')).toBeHidden({ timeout: 5_000 }).catch(() => {})

  // Dashboard "Chốt quán" tool opens /decision/new, which creates the session
  // and lands on the real room URL.
  await page.getByRole('button', { name: 'Chốt quán', exact: true }).click()
  await page.waitForURL(/\/decision\/\d+/, { timeout: 15_000 })

  // Mint the invite link and lift the token off the displayed URL.
  await page.getByRole('button', { name: 'Link mời nhóm' }).click()
  const linkText = await page.locator('header p', { hasText: '/d/' }).textContent()
  const token = /\/d\/([A-Za-z0-9_-]+)/.exec(linkText ?? '')?.[1]
  expect(token).toBeTruthy()

  // One candidate — quick-create a place straight on the room.
  await page.getByPlaceholder('Tên quán mới').fill('Cà Phê E2E')
  await page.getByPlaceholder('lat').fill('10.7769')
  await page.getByPlaceholder('lng').fill('106.7009')
  await page.getByRole('button', { name: 'Thêm', exact: true }).click()
  await expect(page.getByText('Cà Phê E2E').first()).toBeVisible()

  // The participant joins from a *fresh* browser context — anonymous, no TREK
  // login — exactly the wedge the scoped invite token exists for.
  const guest = await browser.newPage()
  await guest.goto(`/d/${token}`)
  await guest.getByPlaceholder(/Tên của bạn/).fill('An')
  await guest.getByRole('button', { name: 'Tham gia' }).click()

  // Minimal context: an origin label is enough — max-travel defaults, the rest
  // is optional. Then the participant is parked on the waiting screen.
  await guest.getByPlaceholder('Ví dụ: Bến Thành').fill('Bến Thành')
  await guest.getByRole('button', { name: 'Xong — chờ kết quả' }).click()
  await expect(guest.getByText('Xong rồi!')).toBeVisible()

  // The join broadcast lands on the host's roster (realtime); wait for it so
  // the resolve button's participant gate opens.
  await expect(page.getByText('An').first()).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Tìm quán phù hợp nhất' }).click()
  await expect(page.getByRole('button', { name: 'Chọn quán này' }).first()).toBeVisible({ timeout: 15_000 })

  // Participant polls every 3s and flips to the result screen on its own.
  await expect(guest.getByText('Nhóm đã có gợi ý')).toBeVisible({ timeout: 20_000 })
  await expect(guest.getByRole('button', { name: 'Điều hướng' }).first()).toBeVisible()

  // Host locks the venue.
  await page.getByRole('button', { name: 'Chọn quán này' }).first().click()
  await expect(page.getByText('Đã chọn — chọn lại?').first()).toBeVisible()

  await guest.close()
})
