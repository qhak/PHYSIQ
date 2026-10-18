function affiliateMoney(cents){
  return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format((Number(cents)||0)/100);
}

async function showAffiliateDashboard(){
  if(!await requireWorkspaceAccess('screen-affiliate'))return;
  if(!hasFreshEntitlementToken())await refreshEntitlementToken();
  await refreshDevAccess();
  if(!affiliateAllowed){showDashboard();return;}
  show('screen-affiliate');
  const host=document.getElementById('affiliateBody');
  host.textContent='Loading your affiliate activity…';
  const accountEmail=userEmail;
  try{
    async function request(){return fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+entitlementToken},body:JSON.stringify({action:'affiliate_dashboard'})});}
    let response=await request();
    if(response.status===401&&await refreshEntitlementToken())response=await request();
    if(!response.ok)throw new Error(response.status===403?'Affiliate access is unavailable for this account.':'Could not load your activity. Try again.');
    const data=await response.json();
    if(!affiliateAllowed||accountEmail!==userEmail)return;
    const summary=data.summary||{}, partner=data.affiliate||{};
    const recent=Array.isArray(data.recent)?data.recent:[];
    const links=Array.isArray(partner.links)?partner.links:[];
    const rows=recent.map(row=>`<tr><td data-label="Date">${esc(new Date((Number(row.created)||0)*1000).toLocaleDateString())}</td><td data-label="Product">${esc(row.product||'Purchase')}</td><td data-label="Type">${esc(row.kind==='renewal'?'Renewal':'Sale')}</td><td data-label="Status">${esc(row.status==='refunded'?'Refunded':row.status==='partially_refunded'?'Partial refund':'Paid')}</td><td data-label="Commission">${affiliateMoney(row.commission_cents)}</td></tr>`).join('');
    host.innerHTML=`<div class="affiliate-stats">
      <div><span>Sales</span><strong>${Number(summary.sales)||0}</strong></div>
      <div><span>Renewals</span><strong>${Number(summary.renewals)||0}</strong></div>
      <div><span>Estimated commission</span><strong>${affiliateMoney(summary.earned_cents)}</strong></div>
    </div>
    <div class="affiliate-share"><h2>Your referral link</h2><div class="affiliate-share-line"><input id="affiliateLink" readonly value="${esc(partner.referral_url||'')}"><button class="db-primary" onclick="copyAffiliateLink()">Copy link</button></div>
      <p>Your referral code: <strong>${esc(partner.referral_code||partner.id||'')}</strong></p>
      ${links.length?'<details class="affiliate-code-list"><summary>All your referral codes ('+links.length+')</summary><ul>'+links.map(link=>'<li><strong>'+esc(link.code)+'</strong><a href="'+esc(link.url)+'" target="_blank" rel="noopener">'+esc(link.url)+'</a><button class="btn ghost" onclick="copyAffiliateCode(this)">Copy code</button></li>').join('')+'</ul></details>':''}
      <p>${partner.code?'Your 20% off discount code: <strong>'+esc(partner.code)+'</strong>':'Your customer discount code is awaiting setup.'}</p><p>Commission is 35% of the listed price for a confirmed sale, adjusted for refunds. Estimates are shown in USD before monthly payout review.</p>
      <button class="btn ghost" onclick="showDevAccess()">Open private studio →</button></div>
    <div class="affiliate-activity"><h2>Recent activity</h2>${rows?`<div class="affiliate-table-wrap"><table><thead><tr><th>Date</th><th>Product</th><th>Type</th><th>Status</th><th>Commission</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p>No referred sales yet. Share your link or code to get started.</p>'}</div>`;
  }catch(error){host.textContent=error.message||'Could not load your activity. Try again.';}
}

async function copyAffiliateCode(button){
  const code=button.closest('li')?.querySelector('strong')?.textContent;
  if(!code)return;
  try{await navigator.clipboard.writeText(code);showToast('Referral code copied.');}
  catch{showToast('Select and copy the code shown.');}
}

async function copyAffiliateLink(){
  const value=document.getElementById('affiliateLink')?.value;
  if(!value)return;
  try{await navigator.clipboard.writeText(value);showToast('Referral link copied.');}
  catch{showToast('Select and copy the link above.');}
}
