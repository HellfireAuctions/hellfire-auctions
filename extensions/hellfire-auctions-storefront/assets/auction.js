(()=>{"use strict";let t=document.getElementById("hellfire-auction-root");const e=t?.dataset.productId||"",i=e?"/apps/hellfire-auctions/auction?product_id="+encodeURIComponent("gid://shopify/Product/"+e):"";let a=null,n=null;const o=t=>{try{return new Intl.NumberFormat(void 0,{style:"currency",currency:window.__hfCurrency||"USD"}).format(Number(t||0))}catch(e){return"$"+Number(t||0).toFixed(2)}},l=()=>{document.querySelectorAll("form[action*='/cart/add'],button[name='add'],button[type='submit'][name='add'],button[data-testid*='add-to-cart'],button[data-action='add-to-cart'],[data-add-to-cart],[data-add-to-cart-button],[data-quick-add],quick-add-component,add-to-cart-component,sticky-add-to-cart").forEach(t=>{t.closest("#hellfire-auction-root")||(t.style.setProperty("display","none","important"),t.style.setProperty("visibility","hidden","important"),t.style.setProperty("pointer-events","none","important"))})};async function r(){if(t&&i)try{let c=null,ok=!1;const pf=window.__hellfireAuctionPrefetch;if(pf){window.__hellfireAuctionPrefetch=null;c=await pf;ok=!!c}if(!c){const a=await fetch(i,{credentials:"same-origin",headers:{Accept:"application/json"},cache:"no-store"});c=await a.json();ok=a.ok}if(!ok||!c.auction)throw new Error(c&&c.error||"Auction unavailable");c.now&&(window.__hfOffset=Date.parse(c.now)-Date.now()),c.currency&&(window.__hfCurrency=c.currency);(e=>{const i=e.auction,a=Number(i.currentBid||0),n=Number(i.startingBid||0),l=Number(i.minimumBid??(a>0?a+1:n));t.querySelector(".hellfire-auction-bid-form")||(t.innerHTML='<section class="hellfire-auction-card" aria-label="Live auction"><div class="hellfire-auction-badge">🔥 LIVE AUCTION</div><div class="hellfire-auction-grid"><div class="hellfire-auction-stat"><span class="hellfire-auction-label">Highest Bid</span><span class="hellfire-auction-value hellfire-auction-current-bid"></span></div><div class="hellfire-auction-stat"><span class="hellfire-auction-label">Starting Bid</span><span class="hellfire-auction-value hellfire-auction-starting-bid"></span></div><div class="hellfire-auction-stat"><span class="hellfire-auction-label">Bids</span><span class="hellfire-auction-value hellfire-auction-bid-count"></span></div><div class="hellfire-auction-stat"><span class="hellfire-auction-label">Highest Bidder</span><span class="hellfire-auction-value hellfire-auction-bidder"></span></div></div><div class="hellfire-auction-reserve"></div><div class="hellfire-auction-countdown"></div><div class="hellfire-auction-status"></div><div class="hellfire-auction-my-status"></div><div class="hellfire-auction-my-max"></div>'+(e.loggedInCustomerId?'<a class="hellfire-auction-my-link" href="/apps/hellfire-auctions/my-auctions">See all my auctions \u2192</a>':'')+'<form class="hellfire-auction-bid-form" novalidate><input name="amount" type="number" step="0.01" inputmode="decimal" min="'+l.toFixed(2)+'" placeholder="Minimum '+o(l)+'" aria-label="Maximum bid" required><button class="hellfire-auction-bid-button" type="submit">'+(e.loggedInCustomerId?"INCREASE BID 🔥":"LOG IN TO BID 🔥")+'</button></form><div class="hellfire-auction-buynow"></div><div class="hellfire-auction-message">'+(e.loggedInCustomerId?"Enter your maximum bid and increase your bid.":"Log in to your customer account to place a bid.")+"</div></section>"),t.querySelector(".hellfire-auction-current-bid").textContent=o(a||n),window.__hfCurrentBid=a||n,window.__hfBuyNow={price:i.buyNowPrice,available:!!i.buyNowAvailable},t.querySelector(".hellfire-auction-starting-bid").textContent=o(n),t.querySelector(".hellfire-auction-bid-count").textContent=String(Number(i.bidCount ?? i.bids?.length ?? 0)),t.querySelector(".hellfire-auction-bidder").textContent=i.highestBidder||"No bids",t.querySelector(".hellfire-auction-status").textContent="UPCOMING"===i.status?"Auction has not started yet":"ENDED"===i.status?"Auction has ended":"Auction is LIVE";const m=t.querySelector(".hellfire-auction-my-max");m.textContent=e.loggedInCustomerId?(i.myMaximumBid!=null?"Your Maximum Bid: "+o(i.myMaximumBid):"You have not placed a bid yet."):"";const rv=t.querySelector(".hellfire-auction-reserve");if(rv){rv.className="hellfire-auction-reserve";rv.textContent="";if(i.hasReserve){rv.classList.add(i.reserveMet?"is-met":"is-not-met");rv.textContent=i.reserveMet?"\u2714 Reserve met":"Reserve not met"}}const ms=t.querySelector(".hellfire-auction-my-status");if(ms){ms.className="hellfire-auction-my-status";ms.textContent="";const st=e.loggedInCustomerId?i.myStatus:null;if(st){ms.classList.add("is-"+st.toLowerCase());ms.textContent={WINNING:"\u2714 You're WINNING this auction!",OUTBID:"\u2716 You've been OUTBID \u2014 bid again!",WON:"\u{1F3C6} You WON this auction!",LOST:"This auction has ended \u2014 you didn't win.",RESERVE_NOT_MET:"Auction ended \u2014 the reserve wasn't met, so there's no sale."}[st]||"";if(st==="WINNING"&&i.hasReserve&&!i.reserveMet){ms.className="hellfire-auction-my-status is-reserve";ms.textContent="\u2714 You're the high bidder \u2014 reserve not met yet"}if(st==="RESERVE_NOT_MET")ms.className="hellfire-auction-my-status is-lost"}}const r=t.querySelector(".hellfire-auction-bid-form input"),c=t.querySelector(".hellfire-auction-bid-button"),s="LIVE"===i.status;r.disabled=!s,c.disabled=!s,r.min=l.toFixed(2),r.placeholder="Minimum "+o(l)})(c),(e=>{clearInterval(n);const i=()=>{const i=t?.querySelector(".hellfire-auction-countdown");if(!i)return;const a=new Date(e).getTime()-(Date.now()+(window.__hfOffset||0));if(a<=0)return i.textContent=window.__hfUpcoming?"⏱ Starting now\u2026":"⏱ Auction ended",void clearInterval(n);const o=Math.floor(a/1e3),l=Math.floor(o/86400),r=Math.floor(o%86400/3600),c=Math.floor(o%3600/60),s=o%60;i.innerHTML="⏱ "+l+"d "+r+"h "+c+"m "+s+"s <span class='hellfire-auction-remaining'>"+(window.__hfUpcoming?"until start":"remaining")+"</span>"};i(),n=setInterval(i,1e3)})((window.__hfUpcoming="UPCOMING"===c.auction.status)?c.auction.startsAt:c.auction.endsAt),(i=>{const a=t?.querySelector(".hellfire-auction-bid-form");a&&"true"!==a.dataset.bound&&(a.dataset.bound="true",a.addEventListener("submit",async n=>{if(n.preventDefault(),n.stopPropagation(),!i.loggedInCustomerId)return void(location.href="/account/login?return_url="+encodeURIComponent(location.pathname+location.search));const l=a.querySelector("input[name='amount']"),c=a.querySelector("button"),s=t.querySelector(".hellfire-auction-message"),d=Number(l.value);if(!Number.isFinite(d)||d<Number(l.min))return s.textContent="Enter at least "+o(l.min)+".",void l.focus();c.disabled=!0,s.textContent="Submitting bid…";try{const t=new FormData(a);t.append("product_id","gid://shopify/Product/"+e);const i=await fetch("/apps/hellfire-auctions/auction",{method:"POST",credentials:"same-origin",body:t}),n=await i.json();if(!i.ok)throw new Error(n.error||"Bid failed");l.value="",s.textContent="Bid accepted.",await r()}catch(t){s.textContent=t.message||"Bid failed",c.disabled=!1}}))})(c),l()}catch(e){console.error("HELLFIRE AUCTIONS:",e),t.innerHTML='<section class="hellfire-auction-card" aria-label="Auction status"><div class="hellfire-auction-badge">🔥 LIVE AUCTION</div><h2>Auction temporarily unavailable</h2><div class="hellfire-auction-status">We will retry automatically.</div></section>'}}const c=()=>{t=document.getElementById("hellfire-auction-root"),t&&e&&(clearInterval(a),clearInterval(n),a=null,n=null,l(),r(),a=setInterval(r,2e3))};if(window.__hellfireAuctionRemount=c,t&&e)c();else{const t=new MutationObserver(()=>{const e=document.getElementById("hellfire-auction-root");e?.dataset.productId&&(t.disconnect(),c())});t.observe(document.documentElement,{childList:!0,subtree:!0})}})();
;(function(){
  function fmt(v){try{return new Intl.NumberFormat(void 0,{style:"currency",currency:window.__hfCurrency||"USD"}).format(Number(v||0))}catch(e){return"$"+Number(v||0).toFixed(2)}}
  document.addEventListener("submit",function(ev){
    var f=ev.target;
    if(!f||!f.classList||!f.classList.contains("hellfire-auction-bid-form"))return;
    if(f.dataset.hfConfirmed==="1"){f.dataset.hfConfirmed="0";return}
    var input=f.querySelector("input[name='amount']"),btn=f.querySelector("button");
    var amt=Number(input&&input.value);
    if(btn&&/log in/i.test(btn.textContent||""))return;
    if(!input||!isFinite(amt)||amt<=0||amt<Number(input.min||0))return;
    ev.preventDefault();ev.stopImmediatePropagation();
    var old=f.parentNode.querySelector(".hellfire-auction-confirm");if(old)old.remove();
    var cur=Number(window.__hfCurrentBid||0);
    var big=cur>0&&amt>=cur*10&&amt-cur>=100;
    var box=document.createElement("div");
    box.className="hellfire-auction-confirm"+(big?" is-warning":"");
    box.setAttribute("role","alertdialog");box.setAttribute("aria-live","assertive");
    box.innerHTML='<div class="hellfire-auction-confirm-title"></div><div class="hellfire-auction-confirm-text"></div><div class="hellfire-auction-confirm-actions"><button type="button" class="hellfire-auction-confirm-yes"></button><button type="button" class="hellfire-auction-confirm-no">Edit bid</button></div>';
    box.querySelector(".hellfire-auction-confirm-title").textContent="Confirm your maximum bid of "+fmt(amt);
    box.querySelector(".hellfire-auction-confirm-text").textContent=(big?"That is more than 10 times the current bid ("+fmt(cur)+"). Check for an extra digit. ":"")+"Bids are binding. If you win, you are committing to buy this item.";
    var yes=box.querySelector(".hellfire-auction-confirm-yes");
    yes.textContent=big?"Yes, bid "+fmt(amt):"Confirm bid";
    f.parentNode.insertBefore(box,f.nextSibling);yes.focus();
    yes.addEventListener("click",function(){box.remove();f.dataset.hfConfirmed="1";if(f.requestSubmit)f.requestSubmit();else f.dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}))});
    box.querySelector(".hellfire-auction-confirm-no").addEventListener("click",function(){box.remove();input.focus()});
  },true);
})();
;(function(){
  var RX=/^(sold out|out of stock|unavailable)$/i;
  setInterval(function(){
    var r=document.getElementById("hellfire-auction-root");if(!r)return;
    var s=r.closest("section");if(!s)return;
    s.querySelectorAll("span, div, p, strong, small").forEach(function(el){
      if(el.children.length||r.contains(el))return;
      if(RX.test((el.textContent||"").trim()))el.style.setProperty("display","none","important");
    });
  },1500);
})();
;(function(){
  function fmt(v){try{return new Intl.NumberFormat(void 0,{style:"currency",currency:window.__hfCurrency||"USD"}).format(Number(v||0))}catch(e){return"$"+Number(v||0).toFixed(2)}}
  function loggedIn(){var f=document.querySelector(".hellfire-auction-bid-form"),b=f&&f.querySelector("button");return !!(b&&!/log in/i.test(b.textContent||""))}
  function render(){
    var box=document.querySelector(".hellfire-auction-buynow");if(!box)return;
    var st=window.__hfBuyNow||{};
    var show=!!st.available&&Number(st.price)>0;
    if(!show){if(box.dataset.on){box.innerHTML="";delete box.dataset.on}return}
    if(!box.dataset.on){
      box.dataset.on="1";
      box.innerHTML='<button type="button" class="hellfire-auction-buynow-btn"></button>';
      box.querySelector("button").addEventListener("click",onClick);
    }
    var b=box.querySelector(".hellfire-auction-buynow-btn");
    if(b)b.textContent=(loggedIn()?"Buy it now":"Log in to buy")+" \u2014 "+fmt(st.price);
  }
  function onClick(){
    if(!loggedIn()){location.href="/account/login?return_url="+encodeURIComponent(location.pathname+location.search);return}
    var box=document.querySelector(".hellfire-auction-buynow"),st=window.__hfBuyNow||{};
    var old=box.querySelector(".hellfire-auction-confirm");if(old)old.remove();
    var c=document.createElement("div");c.className="hellfire-auction-confirm";c.setAttribute("role","alertdialog");
    c.innerHTML='<div class="hellfire-auction-confirm-title"></div><div class="hellfire-auction-confirm-text"></div><div class="hellfire-auction-confirm-actions"><button type="button" class="hellfire-auction-confirm-yes"></button><button type="button" class="hellfire-auction-confirm-no">Cancel</button></div>';
    c.querySelector(".hellfire-auction-confirm-title").textContent="Buy it now for "+fmt(st.price)+"?";
    c.querySelector(".hellfire-auction-confirm-text").textContent="This ends the auction right away and you win the item at this price. Purchases are binding.";
    var yes=c.querySelector(".hellfire-auction-confirm-yes");yes.textContent="Yes, buy it now";
    box.appendChild(c);yes.focus();
    c.querySelector(".hellfire-auction-confirm-no").addEventListener("click",function(){c.remove()});
    yes.addEventListener("click",function(){
      yes.disabled=true;
      var root=document.getElementById("hellfire-auction-root"),fd=new FormData();
      fd.append("product_id","gid://shopify/Product/"+(root&&root.dataset.productId));
      fetch("/apps/hellfire-auctions/auction-buynow",{method:"POST",credentials:"same-origin",body:fd})
        .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
        .then(function(x){
          var m=document.querySelector(".hellfire-auction-message");
          if(m)m.textContent=x.ok?(x.j.message||"You bought it!"):(x.j.error||"Buy It Now failed.");
          c.remove();
          if(window.__hellfireAuctionRemount)window.__hellfireAuctionRemount();
        })
        .catch(function(){var m=document.querySelector(".hellfire-auction-message");if(m)m.textContent="Buy It Now failed. Please try again.";c.remove()});
    });
  }
  setInterval(render,700);
})();
