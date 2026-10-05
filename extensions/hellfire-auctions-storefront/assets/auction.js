;(function(){
  /* Hellfire Auctions storefront language + currency helpers (theme-neutral). */
  var raw=(window.Shopify&&window.Shopify.locale)||document.documentElement.getAttribute("lang")||"en";
  var L=String(raw).slice(0,2).toLowerCase();
  var ES={"{n} bidders":"{n} postores","{n} watching":"{n} siguiendo","Live auction":"Subasta en vivo","LIVE AUCTION":"SUBASTA EN VIVO","Highest Bid":"Puja más alta","Starting Bid":"Puja inicial","Bids":"Pujas","Highest Bidder":"Mejor postor","See all my auctions":"Ver todas mis subastas","Minimum":"Mínimo","Maximum bid":"Puja máxima","INCREASE BID":"PUJAR","LOG IN TO BID":"INICIA SESIÓN PARA PUJAR","Enter your maximum bid and increase your bid.":"Ingresa tu puja máxima y puja.","Log in to your customer account to place a bid.":"Inicia sesión en tu cuenta de cliente para pujar.","Bid history":"Historial de pujas","No bids":"Sin pujas","Auction has not started yet":"La subasta aún no ha comenzado","Auction has ended":"La subasta ha terminado","Auction is LIVE":"La subasta está EN VIVO","Your Maximum Bid: ":"Tu puja máxima: ","You have not placed a bid yet.":"Aún no has pujado.","Reserve met":"Precio de reserva alcanzado","Reserve not met":"Precio de reserva no alcanzado","You're WINNING this auction!":"¡Vas GANANDO esta subasta!","You've been OUTBID — bid again!":"Te han SUPERADO: ¡vuelve a pujar!","You WON this auction!":"¡GANASTE esta subasta!","This auction has ended — you didn't win.":"Esta subasta terminó: no ganaste.","Auction ended — the reserve wasn't met, so there's no sale.":"Subasta terminada: no se alcanzó el precio de reserva, así que no hay venta.","You're the high bidder — reserve not met yet":"Eres el mejor postor: aún no se alcanza el precio de reserva","Starting now…":"Comenzando…","Auction ended":"Subasta terminada","until start":"para comenzar","remaining":"restantes","Enter at least":"Ingresa al menos","Submitting bid…":"Enviando puja…","Bid failed":"No se pudo pujar","Bid accepted.":"Puja aceptada.","Auction status":"Estado de la subasta","Auction temporarily unavailable":"Subasta no disponible temporalmente","We will retry automatically.":"Lo intentaremos de nuevo automáticamente.","Edit bid":"Editar puja","Confirm your maximum bid of":"Confirma tu puja máxima de","That is more than 10 times the current bid":"Es más de 10 veces la puja actual","Check for an extra digit.":"Revisa que no sobre un dígito.","Bids are binding. If you win, you are committing to buy this item.":"Las pujas son vinculantes. Si ganas, te comprometes a comprar este artículo.","Bids are placed in":"Las pujas se hacen en","Yes, bid":"Sí, pujar","Confirm bid":"Confirmar puja","No bids recorded yet.":"Aún no hay pujas.","You":"Tú","Bid":"Pujar","Log in to get a reminder":"Inicia sesión para recibir un recordatorio","Log in to watch this auction":"Inicia sesión para seguir esta subasta","We'll email you when it starts":"Te avisaremos por email cuando empiece","Watching — we'll email you before it ends":"Siguiendo: te avisaremos por email antes de que termine","Remind me when it starts":"Avísame cuando empiece","Watch this auction":"Seguir esta subasta","Anti-sniping is on: a bid in the last 2 minutes adds 2 minutes.":"Protección de último minuto activa: una puja en los últimos 2 minutos añade 2 minutos.","TEST AUCTION: not a real sale.":"SUBASTA DE PRUEBA: no es una venta real.","Missing shop or product.":"Falta la tienda o el producto.","Please sign in to place a bid.":"Inicia sesión para pujar.","You can't place bids on this store's auctions.":"No puedes pujar en las subastas de esta tienda.","You're bidding too fast. Please wait a second and try again.":"Estás pujando demasiado rápido. Espera un segundo e inténtalo de nuevo.","Enter a valid bid.":"Ingresa una puja válida.","That bid is above the allowed maximum.":"Esa puja supera el máximo permitido.","Auction not found.":"Subasta no encontrada.","This auction has not started yet.":"Esta subasta aún no ha comenzado.","This auction has ended.":"Esta subasta ha terminado.","Your maximum bid must be at least the minimum bid.":"Tu puja máxima debe ser al menos la puja mínima.","Your maximum bid is already at or above that amount.":"Tu puja máxima ya es igual o superior a esa cantidad."};
  window.__hfLang=L;
  window.__hfT=function(s){return L==="es"&&Object.prototype.hasOwnProperty.call(ES,s)?ES[s]:s};
  function other(){var c=window.Shopify&&window.Shopify.currency,shop=window.__hfCurrency;return c&&c.active&&shop&&c.active!==shop?c:null}
  window.__hfApprox=function(v){try{var c=other(),rate=c?Number(c.rate):0;if(!c||!(rate>0))return "";return " (\u2248 "+new Intl.NumberFormat(L==="es"?"es":void 0,{style:"currency",currency:c.active}).format(Number(v||0)*rate)+")"}catch(e){return ""}};
  window.__hfCurrencyNote=function(){return other()?" "+window.__hfT("Bids are placed in")+" "+window.__hfCurrency+".":""};
})();
(()=>{"use strict";let t=document.getElementById("hellfire-auction-root");const e=t?.dataset.productId||"",i=e?"/apps/hellfire-auctions/auction?product_id="+encodeURIComponent("gid://shopify/Product/"+e):"";let a=null,n=null;const o=t=>{try{return new Intl.NumberFormat(void 0,{style:"currency",currency:window.__hfCurrency||"USD"}).format(Number(t||0))}catch(e){return"$"+Number(t||0).toFixed(2)}},l=()=>{document.querySelectorAll("form[action*='/cart/add'],button[name='add'],button[type='submit'][name='add'],button[data-testid*='add-to-cart'],button[data-action='add-to-cart'],[data-add-to-cart],[data-add-to-cart-button],[data-quick-add],quick-add-component,add-to-cart-component,sticky-add-to-cart").forEach(t=>{t.closest("#hellfire-auction-root")||(t.style.setProperty("display","none","important"),t.style.setProperty("visibility","hidden","important"),t.style.setProperty("pointer-events","none","important"))})};async function r(){if(t&&i)try{let c=null,ok=!1;const pf=window.__hellfireAuctionPrefetch;if(pf){window.__hellfireAuctionPrefetch=null;c=await pf;ok=!!c}if(!c){const a=await fetch(i,{credentials:"same-origin",headers:{Accept:"application/json"},cache:"no-store"});c=await a.json();ok=a.ok}if(!ok||!c.auction)throw new Error(c&&c.error||"Auction unavailable");c.now&&(window.__hfOffset=Date.parse(c.now)-Date.now()),c.currency&&(window.__hfCurrency=c.currency);(e=>{const i=e.auction,a=Number(i.currentBid||0),n=Number(i.startingBid||0),l=Number(i.minimumBid??(a>0?a+1:n));t.querySelector(".hellfire-auction-bid-form")||(t.innerHTML='<section class="hellfire-auction-card" aria-label="'+__hfT("Live auction")+'"><div class="hellfire-auction-badge">🔥 '+__hfT("LIVE AUCTION")+'</div><div class="hellfire-auction-grid"><div class="hellfire-auction-stat"><span class="hellfire-auction-label">'+__hfT("Highest Bid")+'</span><span class="hellfire-auction-value hellfire-auction-current-bid"></span></div><div class="hellfire-auction-stat"><span class="hellfire-auction-label">'+__hfT("Starting Bid")+'</span><span class="hellfire-auction-value hellfire-auction-starting-bid"></span></div><div class="hellfire-auction-stat"><span class="hellfire-auction-label">'+__hfT("Bids")+'</span><span class="hellfire-auction-value hellfire-auction-bid-count"></span></div><div class="hellfire-auction-stat"><span class="hellfire-auction-label">'+__hfT("Highest Bidder")+'</span><span class="hellfire-auction-value hellfire-auction-bidder"></span></div></div><div class="hellfire-auction-reserve"></div><div class="hellfire-auction-countdown"></div><div class="hellfire-auction-status"></div><div class="hellfire-auction-my-status" aria-live="polite"></div><div class="hellfire-auction-my-max"></div>'+(e.loggedInCustomerId?'<a class="hellfire-auction-my-link" href="'+((window.Shopify&&Shopify.routes&&Shopify.routes.root)||"/")+'apps/hellfire-auctions/my-auctions">'+__hfT("See all my auctions")+' \u2192</a>':'')+'<form class="hellfire-auction-bid-form" novalidate><input name="amount" type="number" step="0.01" inputmode="decimal" min="'+l.toFixed(2)+'" placeholder="'+__hfT("Minimum")+' '+o(l)+'" aria-label="'+__hfT("Maximum bid")+'" required><button class="hellfire-auction-bid-button" type="submit"'+(e.loggedInCustomerId?'':' data-hf-login="1"')+'>'+(e.loggedInCustomerId?__hfT("INCREASE BID")+" 🔥":__hfT("LOG IN TO BID")+" 🔥")+'</button></form><div class="hellfire-auction-message" aria-live="polite">'+(e.loggedInCustomerId?__hfT("Enter your maximum bid and increase your bid."):__hfT("Log in to your customer account to place a bid."))+"</div><details class='hellfire-auction-history'><summary>"+__hfT("Bid history")+"</summary><div class='hellfire-auction-history-list'></div></details></section>"),t.querySelector(".hellfire-auction-current-bid").textContent=o(a||n)+__hfApprox(a||n),window.__hfCurrentBid=a||n,window.__hfHistory=i.history||[],window.__hfWatch={can:!!i.canWatch,on:!!i.watching,status:i.status},window.__hfSocial={watchers:Number(i.watchers||0),bidders:Number(i.bidders||0),live:"LIVE"===i.status},window.__hfLeave={ended:"ENDED"===i.status,mine:i.myStatus||null,endsAt:i.endsAt},window.__hfExtend=!!i.autoExtend,window.__hfTest=!!i.isTest,window.__hfEnded="ENDED"===i.status,t.querySelector(".hellfire-auction-starting-bid").textContent=o(n),t.querySelector(".hellfire-auction-bid-count").textContent=String(Number(i.bidCount ?? i.bids?.length ?? 0)),t.querySelector(".hellfire-auction-bidder").textContent=i.highestBidder||__hfT("No bids"),(t.querySelector(".hellfire-auction-status").dataset.state=i.status),t.querySelector(".hellfire-auction-status").textContent="UPCOMING"===i.status?__hfT("Auction has not started yet"):"ENDED"===i.status?__hfT("Auction has ended"):__hfT("Auction is LIVE");const m=t.querySelector(".hellfire-auction-my-max");m.textContent=e.loggedInCustomerId?(i.myMaximumBid!=null?__hfT("Your Maximum Bid: ")+o(i.myMaximumBid):__hfT("You have not placed a bid yet.")):"";const rv=t.querySelector(".hellfire-auction-reserve");if(rv){rv.className="hellfire-auction-reserve";rv.textContent="";if(i.hasReserve){rv.classList.add(i.reserveMet?"is-met":"is-not-met");rv.textContent=i.reserveMet?"\u2714 "+__hfT("Reserve met"):__hfT("Reserve not met")}}const ms=t.querySelector(".hellfire-auction-my-status");if(ms){ms.className="hellfire-auction-my-status";ms.textContent="";const st=e.loggedInCustomerId?i.myStatus:null;if(st){ms.classList.add("is-"+st.toLowerCase());ms.textContent={WINNING:"\u2714 "+__hfT("You're WINNING this auction!"),OUTBID:"\u2716 "+__hfT("You've been OUTBID \u2014 bid again!"),WON:"\u{1F3C6} "+__hfT("You WON this auction!"),LOST:__hfT("This auction has ended \u2014 you didn't win."),RESERVE_NOT_MET:__hfT("Auction ended \u2014 the reserve wasn't met, so there's no sale.")}[st]||"";if(st==="WINNING"&&i.hasReserve&&!i.reserveMet){ms.className="hellfire-auction-my-status is-reserve";ms.textContent="\u2714 "+__hfT("You're the high bidder \u2014 reserve not met yet")}if(st==="RESERVE_NOT_MET")ms.className="hellfire-auction-my-status is-lost"}}const r=t.querySelector(".hellfire-auction-bid-form input"),c=t.querySelector(".hellfire-auction-bid-button"),s="LIVE"===i.status;r.disabled=!s,c.disabled=!s,r.min=l.toFixed(2),r.placeholder=__hfT("Minimum")+" "+o(l)})(c),(e=>{clearInterval(n);const i=()=>{const i=t?.querySelector(".hellfire-auction-countdown");if(!i)return;const a=new Date(e).getTime()-(Date.now()+(window.__hfOffset||0));if(a<=0)return i.textContent=window.__hfUpcoming?"⏱ "+__hfT("Starting now\u2026"):"⏱ "+__hfT("Auction ended"),void clearInterval(n);const o=Math.floor(a/1e3),l=Math.floor(o/86400),r=Math.floor(o%86400/3600),c=Math.floor(o%3600/60),s=o%60;i.innerHTML="⏱ "+l+"d "+r+"h "+c+"m "+s+"s <span class='hellfire-auction-remaining'>"+(window.__hfUpcoming?__hfT("until start"):__hfT("remaining"))+"</span>"};i(),n=setInterval(i,1e3)})((window.__hfUpcoming="UPCOMING"===c.auction.status)?c.auction.startsAt:c.auction.endsAt),(i=>{const a=t?.querySelector(".hellfire-auction-bid-form");a&&"true"!==a.dataset.bound&&(a.dataset.bound="true",a.addEventListener("submit",async n=>{if(n.preventDefault(),n.stopPropagation(),!i.loggedInCustomerId)return void(location.href="/account/login?return_url="+encodeURIComponent(location.pathname+location.search));const l=a.querySelector("input[name='amount']"),c=a.querySelector("button"),s=t.querySelector(".hellfire-auction-message"),d=Number(l.value);if(!Number.isFinite(d)||d<Number(l.min))return s.textContent=__hfT("Enter at least")+" "+o(l.min)+".",void l.focus();c.disabled=!0,s.textContent=__hfT("Submitting bid…");try{const t=new FormData(a);t.append("product_id","gid://shopify/Product/"+e);const i=await fetch("/apps/hellfire-auctions/auction",{method:"POST",credentials:"same-origin",body:t}),n=await i.json();if(!i.ok)throw new Error(__hfT(n.error||"Bid failed"));l.value="",s.textContent=__hfT("Bid accepted."),await r()}catch(t){s.textContent=t.message||__hfT("Bid failed"),c.disabled=!1}}))})(c),l()}catch(e){console.error("HELLFIRE AUCTIONS:",e),t.innerHTML='<section class="hellfire-auction-card" aria-label="'+__hfT("Auction status")+'"><div class="hellfire-auction-badge">🔥 '+__hfT("LIVE AUCTION")+'</div><h2>'+__hfT("Auction temporarily unavailable")+'</h2><div class="hellfire-auction-status">'+__hfT("We will retry automatically.")+'</div></section>'}}const c=()=>{t=document.getElementById("hellfire-auction-root"),t&&e&&(clearInterval(a),clearInterval(n),a=null,n=null,l(),r(),a=setInterval(function(){document.hidden||window.__hfEnded||r()},2e3),document.addEventListener("visibilitychange",function(){document.hidden||r()}))};if(window.__hellfireAuctionRemount=c,t&&e)c();else{const t=new MutationObserver(()=>{const e=document.getElementById("hellfire-auction-root");e?.dataset.productId&&(t.disconnect(),c())});t.observe(document.documentElement,{childList:!0,subtree:!0})}})();
;(function(){
  function fmt(v){try{return new Intl.NumberFormat(void 0,{style:"currency",currency:window.__hfCurrency||"USD"}).format(Number(v||0))}catch(e){return"$"+Number(v||0).toFixed(2)}}
  document.addEventListener("submit",function(ev){
    var f=ev.target;
    if(!f||!f.classList||!f.classList.contains("hellfire-auction-bid-form"))return;
    if(f.dataset.hfConfirmed==="1"){f.dataset.hfConfirmed="0";return}
    var input=f.querySelector("input[name='amount']"),btn=f.querySelector("button");
    var amt=Number(input&&input.value);
    if(btn&&btn.getAttribute("data-hf-login")==="1")return;
    if(!input||!isFinite(amt)||amt<=0||amt<Number(input.min||0))return;
    ev.preventDefault();ev.stopImmediatePropagation();
    var old=f.parentNode.querySelector(".hellfire-auction-confirm");if(old)old.remove();
    var cur=Number(window.__hfCurrentBid||0);
    var big=cur>0&&amt>=cur*10&&amt-cur>=100;
    var box=document.createElement("div");
    box.className="hellfire-auction-confirm"+(big?" is-warning":"");
    box.setAttribute("role","alertdialog");box.setAttribute("aria-live","assertive");
    box.innerHTML='<div class="hellfire-auction-confirm-title"></div><div class="hellfire-auction-confirm-text"></div><div class="hellfire-auction-confirm-actions"><button type="button" class="hellfire-auction-confirm-yes"></button><button type="button" class="hellfire-auction-confirm-no">'+__hfT("Edit bid")+'</button></div>';
    box.querySelector(".hellfire-auction-confirm-title").textContent=__hfT("Confirm your maximum bid of")+" "+fmt(amt)+__hfApprox(amt);
    box.querySelector(".hellfire-auction-confirm-text").textContent=(big?__hfT("That is more than 10 times the current bid")+" ("+fmt(cur)+"). "+__hfT("Check for an extra digit.")+" ":"")+__hfT("Bids are binding. If you win, you are committing to buy this item.")+__hfCurrencyNote();
    var yes=box.querySelector(".hellfire-auction-confirm-yes");
    yes.textContent=big?__hfT("Yes, bid")+" "+fmt(amt):__hfT("Confirm bid");
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
  var last="",bar=null;
  function renderHistory(){
    var list=document.querySelector(".hellfire-auction-history-list");if(!list)return;
    var h=window.__hfHistory||[],sig=JSON.stringify(h);if(sig===last)return;last=sig;
    var sum=document.querySelector(".hellfire-auction-history summary");
    if(sum)sum.textContent=__hfT("Bid history")+" ("+h.length+(h.length>=25?"+":"")+")";
    list.innerHTML="";
    if(!h.length){list.textContent=__hfT("No bids recorded yet.");return}
    h.forEach(function(e){
      var row=document.createElement("div");row.className="hellfire-auction-history-row";
      var who=document.createElement("span");who.textContent=e.mine?__hfT("You"):e.bidder;
      var amt=document.createElement("strong");amt.textContent=fmt(e.amount);
      var when=document.createElement("span");
      when.textContent=new Date(e.at).toLocaleString(window.__hfLang==="es"?"es":[],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",second:"2-digit"});
      row.appendChild(who);row.appendChild(amt);row.appendChild(when);list.appendChild(row);
    });
  }
  function ensureBar(){
    if(bar)return bar;
    bar=document.createElement("div");bar.className="hellfire-sticky-bar";
    bar.innerHTML="<div class='hellfire-sticky-info'><strong class='hellfire-sticky-bid'></strong><span class='hellfire-sticky-time'></span></div><button type='button' class='hellfire-sticky-btn'>"+__hfT("Bid")+"</button>";
    bar.querySelector("button").addEventListener("click",function(){var r=document.getElementById("hellfire-auction-root");if(r)r.scrollIntoView({behavior:"smooth",block:"start"})});
    document.body.appendChild(bar);return bar;
  }
  function tickBar(){
    var root=document.getElementById("hellfire-auction-root"),cd=document.querySelector(".hellfire-auction-countdown");
    var mobile=window.matchMedia&&window.matchMedia("(max-width: 768px)").matches;
    var live=root&&((document.querySelector(".hellfire-auction-status")||{dataset:{}}).dataset.state==="LIVE");
    if(!mobile||!root||!live){if(bar)bar.style.display="none";return}
    var rect=root.getBoundingClientRect(),inView=rect.top<window.innerHeight*0.85&&rect.bottom>80,b=ensureBar();
    b.style.display=inView?"none":"flex";
    b.querySelector(".hellfire-sticky-bid").textContent=fmt(window.__hfCurrentBid);
    b.querySelector(".hellfire-sticky-time").textContent=cd?cd.textContent.replace(/\s+/g," ").trim():"";
  }
  setInterval(function(){renderHistory();tickBar()},800);
})();
;(function(){
  var busy=false;
  function loggedIn(){var f=document.querySelector(".hellfire-auction-bid-form"),b=f&&f.querySelector("button");return !!(b&&b.getAttribute("data-hf-login")!=="1")}
  function ensure(){
    var h=document.querySelector(".hellfire-auction-history");if(!h)return null;
    var el=document.querySelector(".hellfire-auction-watch");
    if(!el){
      el=document.createElement("div");el.className="hellfire-auction-watch";
      var b=document.createElement("button");b.type="button";b.className="hellfire-auction-watch-btn";
      b.addEventListener("click",toggle);el.appendChild(b);h.parentNode.insertBefore(el,h);
    }
    return el;
  }
  function render(){
    var w=window.__hfWatch||{},el=document.querySelector(".hellfire-auction-watch");
    if(!w.can||w.status==="ENDED"){if(el)el.style.display="none";return}
    el=ensure();if(!el)return;el.style.display="";
    var b=el.querySelector("button"),up=w.status==="UPCOMING",t;
    if(!loggedIn())t=up?__hfT("Log in to get a reminder"):__hfT("Log in to watch this auction");
    else if(w.on)t=up?"\u2714 "+__hfT("We'll email you when it starts"):"\u2605 "+__hfT("Watching \u2014 we'll email you before it ends");
    else t=up?"\uD83D\uDD14 "+__hfT("Remind me when it starts"):"\u2606 "+__hfT("Watch this auction");
    if(b.textContent!==t)b.textContent=t;
    b.setAttribute("aria-pressed",w.on?"true":"false");
  }
  function toggle(){
    if(!loggedIn()){location.href="/account/login?return_url="+encodeURIComponent(location.pathname+location.search);return}
    if(busy)return;busy=true;
    var root=document.getElementById("hellfire-auction-root"),fd=new FormData();
    fd.append("product_id","gid://shopify/Product/"+(root&&root.dataset.productId));
    fetch("/apps/hellfire-auctions/auction-watch",{method:"POST",credentials:"same-origin",body:fd})
      .then(function(r){return r.json()})
      .then(function(j){if(j&&typeof j.watching==="boolean"&&window.__hfWatch)window.__hfWatch.on=j.watching;render()})
      .catch(function(){})
      .then(function(){busy=false});
  }
  setInterval(render,800);
})();
;(function(){
  function r(){
    var cd=document.querySelector(".hellfire-auction-countdown");if(!cd)return;
    var n=document.querySelector(".hellfire-auction-extend-note");
    if(!window.__hfExtend){if(n)n.remove();return}
    if(!n){
      n=document.createElement("div");n.className="hellfire-auction-extend-note";
      n.textContent=__hfT("Anti-sniping is on: a bid in the last 2 minutes adds 2 minutes.");
      cd.parentNode.insertBefore(n,cd.nextSibling);
    }
  }
  setInterval(r,1000);
})();
;(function(){
  function r(){
    var cd=document.querySelector(".hellfire-auction-countdown");if(!cd)return;
    var n=document.querySelector(".hellfire-auction-test-note");
    if(!window.__hfTest){if(n)n.remove();return}
    if(!n){
      n=document.createElement("div");n.className="hellfire-auction-test-note";
      n.textContent=__hfT("TEST AUCTION: not a real sale.");
      cd.parentNode.insertBefore(n,cd);
    }
  }
  setInterval(r,1000);
})();

;(function(){
  function r(){
    var cd=document.querySelector(".hellfire-auction-countdown");if(!cd)return;
    var s=window.__hfSocial||{},parts=[];
    if(s.live&&s.bidders>=2)parts.push(__hfT("{n} bidders").replace("{n}",s.bidders));
    if(s.live&&s.watchers>=2)parts.push(__hfT("{n} watching").replace("{n}",s.watchers));
    var n=document.querySelector(".hellfire-auction-social");
    if(!parts.length){if(n)n.remove();return}
    if(!n){n=document.createElement("div");n.className="hellfire-auction-social";cd.parentNode.insertBefore(n,cd.nextSibling)}
    var text=parts.join(" \u00b7 ");if(n.textContent!==text)n.textContent=text;
  }
  setInterval(r,1000);
})();

;(function(){
  /* An ended auction stays visible only to people who bid on it (so they can see how it went).
     Everyone else is sent to the live auctions. Add ?keep=1 to a link to look at the page anyway. */
  var done=false;
  function r(){
    if(done)return;
    var s=window.__hfLeave;if(!s||!s.ended||s.mine)return;
    if(window.Shopify&&Shopify.designMode)return;
    if(/[?&]keep=1(&|$)/.test(location.search))return;
    if(Date.now()+(window.__hfOffset||0)-Date.parse(s.endsAt)<=60000)return;
    done=true;
    location.replace(((window.Shopify&&Shopify.routes&&Shopify.routes.root)||"/")+"collections/live-auctions");
  }
  setInterval(r,500);
})();
