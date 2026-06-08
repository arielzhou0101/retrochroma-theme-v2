// @ts-nocheck
// 统一驱动所有带 data-end-time 的 Section
document.querySelectorAll('[data-end-time]').forEach(section => {
  const box   = section.querySelector('.countdown');
  const end   = new Date(section.dataset.endTime).getTime(); // 传入的就是 GMT+0
  let   timer;

  const tpl = (n, label) =>
    `<li><strong>${String(n).padStart(2,'0')}</strong><span>${label}</span></li>`;

  function tick(){
    let diff = end - Date.now();

    if (diff <= 0){
      clearInterval(timer); // 停止计时
      diff = 0;             // 差值改成 0，下面会显示 00:00:00:00
    }

    const d = Math.floor(diff/864e5);
    diff   %= 864e5;
    const h = Math.floor(diff/36e5);
    diff   %= 36e5;
    const m = Math.floor(diff/6e4);
    const s = Math.floor((diff%6e4)/1e3);

    box.innerHTML =
      `<ul class="list">
         ${tpl(d,'Days')}
         ${tpl(h,'Hours')}
         ${tpl(m,'Mins')}
         ${tpl(s,'Secs')}
       </ul>`;
  }

  tick();                   // 首次绘制
  timer = setInterval(tick,1000);
});
