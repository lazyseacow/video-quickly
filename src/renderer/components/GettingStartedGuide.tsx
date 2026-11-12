import { useEffect, useLayoutEffect, useRef } from 'react';
import { driver, type Driver, type PopoverDOM, type Side } from 'driver.js';
import { guideActionSequence, subscribeGuideActions, type GuideAction } from '../lib/guide-actions';
import { shortcutLabel } from '../lib/desktop';
import './getting-started-guide.css';

function visible(element: Element | undefined): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = getComputedStyle(element), rect = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}
function target(name: string) { return [...document.querySelectorAll(`[data-guide="${name}"]`)].find(visible); }
function nativeDialog() { return [...document.querySelectorAll('dialog[open]')].find(visible); }
function loading() { return [...document.querySelectorAll('[data-guide-loading]')].some(visible); }

interface GuideStep { id: string; action: GuideAction; title: string; description: string; side?: Side; when?: () => boolean; }
interface ResolvedStep { definition: GuideStep; order: number; element: HTMLElement; }
function definitions(): GuideStep[] {
  return [
    { id: 'create-project', action: 'project-created', title: '新建创作项目', description: '可以直接点击高亮的“新建项目”，填写主题和创意简报。创建成功并关闭表单后，指引会自动继续；已有项目也可以点“下一步”跳过。', side: 'right' },
    { id: 'models', action: 'models-opened', title: '打开模型连接', description: '点击高亮入口打开模型连接。打开后自动继续；如果准备使用本地图片、视频和配音，也可以手动跳过。', side: 'right' },
    { id: 'model-connection', action: 'model-saved', title: '添加模型连接', description: '点击高亮的添加按钮，选择模型类型，填写服务地址和密钥，再选择型号并保存。保存成功且表单关闭后继续；已有连接可以直接跳过。' },
    { id: 'projects', action: 'projects-opened', title: '打开我的项目', description: '点击左侧图标打开项目列表，再选择一个项目继续创作。也可以使用上方加号创建新项目。', side: 'right', when: () => !target('project-open') && !target('view') && !target('preview') },
    { id: 'project-open', action: 'workbench-opened', title: '进入创作工作台', description: '点击项目卡片上的文件夹图标进入工作台。项目加载完成后，指引会继续介绍镜头、预览和制作区域。' },
    { id: 'view', action: 'production-settings-opened', title: '制作设置', description: '点击“制作设置”配置创作要求和模型。关闭设置后继续介绍工作台。' },
    { id: 'outline-toggle', action: 'outline-opened', title: '展开镜头导航', description: '左侧镜头导航已收起，点击高亮按钮展开。展开后会接着介绍真实的镜头列表。', when: () => !target('shots') },
    { id: 'shots', action: 'shot-selected', title: '整理镜头', description: '直接点击列表中的镜头，查看它的画面、旁白与时长。成功选择镜头后，指引会自动继续。', side: 'right' },
    { id: 'preview', action: 'preview-played', title: '预览画面', description: '可以点击播放按钮，或在此区域按空格播放。预览实际开始播放后继续；也可以先核对画面、字幕和声音。', side: 'left' },
    { id: 'timeline', action: 'timeline-seeked', title: '安排镜头节奏', description: '点击时间轴调整播放位置，成功定位后自动继续。也可以在这里查看镜头顺序、时长与音轨。', side: 'top' },
    { id: 'inspector-toggle', action: 'inspector-opened', title: '展开属性面板', description: '右侧属性面板已收起，点击高亮按钮展开，编辑当前镜头的旁白、素材与运镜。', when: () => !target('inspector') },
    { id: 'inspector', action: 'project-saved', title: '编辑属性', description: `可以编辑旁白、素材与运镜，再用 ${shortcutLabel('S')} 保存。修改保存成功后自动继续；不需要修改时可点“下一步”。`, side: 'left' },
    { id: 'check', action: 'check-completed', title: '制作前检查', description: '从“更多”打开“制作前检查”，可单独排查已保存的配置、素材与运行环境。检查完成并关闭窗口后继续，也可以点“下一步”。' },
    { id: 'produce', action: 'production-started', title: '自动制作', description: '点击“开始制作”会先核对本地配置和素材。有问题时可从报告直接前往修复，通过后各步骤会自动继续生成并保存结果。' },
    { id: 'export', action: 'export-completed', title: '导出成片', description: '检查并保存修改后，点击导出，确认规格和保存路径。成片实际导出成功、取得路径并关闭窗口后，指引才会自动继续。' },
    { id: 'help', action: 'help-used', title: '随时重开指引', description: '点击高亮的“设置”入口，或选择“完成引导”结束。以后可从“设置 → 使用指南”重新查看当前界面的操作指引。', side: 'right' },
  ];
}

export default function GettingStartedGuide({ onClose }: { onClose: () => void }) {
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const steps = definitions();
    let disposed = false, finished = false, suspending = false, frame = 0, focusFrame = 0;
    let cursor = -1, enteredAfter = guideActionSequence(), pending = false, settleFrames = 0;
    let tour: Driver | undefined, popover: PopoverDOM | undefined, plan: ResolvedStep[] = [];
    let renderedOrder = -1, renderedElement: HTMLElement | undefined;
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver(records => {
      if (records.some(record => !owned(record.target) && (record.type !== 'childList' || [...record.addedNodes, ...record.removedNodes].some(node => !owned(node))))) schedule();
    });
    const unsubscribe = subscribeGuideActions(completion => {
      if (cursor < 0 || completion.action !== steps[cursor].action || completion.sequence <= enteredAfter) return;
      pending = true; settleFrames = 2; schedule();
    });

    function owned(node: Node) {
      const element = node instanceof Element ? node : node.parentElement;
      return Boolean(element?.closest('.driver-popover, .driver-overlay, .driver-layer'));
    }
    function resolvePlan(): ResolvedStep[] {
      return steps.flatMap((definition, order) => {
        const element = definition.when?.() === false ? undefined : target(definition.id);
        return element ? [{ definition, order, element }] : [];
      });
    }
    function stop() {
      mutations.disconnect(); resize.disconnect(); unsubscribe();
      document.removeEventListener('scroll', schedule, true); document.removeEventListener('click', schedule, true);
      window.removeEventListener('resize', schedule); window.removeEventListener('keydown', keyboard, true);
      cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame); frame = focusFrame = 0;
    }
    function retireDriver() {
      const current = tour, modal = nativeDialog(), focus = document.activeElement;
      tour = undefined; popover = undefined; renderedOrder = -1; renderedElement = undefined;
      resize.disconnect(); cancelAnimationFrame(focusFrame); focusFrame = 0;
      suspending = true;
      try { current?.destroy(); } finally { suspending = false; }
      if (modal && focus instanceof HTMLElement && focus.isConnected && modal.contains(focus)) focus.focus({ preventScroll: true });
    }
    function restoreFocus() { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); }
    function finish() {
      if (disposed || finished) return;
      finished = true; stop(); retireDriver(); restoreFocus(); close.current();
    }
    function enter(order: number) { cursor = order; enteredAfter = guideActionSequence(); pending = false; settleFrames = 0; }
    function neighbor(direction: number, candidates = plan) {
      return direction > 0 ? candidates.find(item => item.order > cursor) : candidates.findLast(item => item.order < cursor);
    }
    function move(direction: number) {
      const next = neighbor(direction, resolvePlan());
      if (next) { enter(next.order); schedule(); }
      else if (direction > 0) finish();
    }
    function schedule() {
      if (disposed || finished || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; reconcile(); });
    }
    function keyboard(event: KeyboardEvent) {
      if (nativeDialog()) return;
      if (event.key === 'Escape' && document.querySelector('[data-help-tooltip], :popover-open')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(); return; }
      if (!tour?.isActive() || !popover) return;
      const inPopover = event.target instanceof Node && popover.wrapper.contains(event.target);
      if (inPopover && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        event.preventDefault(); event.stopImmediatePropagation(); move(event.key === 'ArrowRight' ? 1 : -1); return;
      }
      if (event.key !== 'Tab') return;
      const active = tour.getActiveElement(), roots = active ? [popover.wrapper, active] : [popover.wrapper];
      const selector = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
      const controls = [...new Set(roots.flatMap(root => [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)]))].filter(visible);
      const index = controls.findIndex(element => element === document.activeElement);
      const next = event.shiftKey ? controls[index - 1] ?? controls.at(-1) : controls[index + 1] ?? controls[0];
      event.preventDefault(); event.stopImmediatePropagation(); next?.focus();
    }
    function observeLayout(element: Element) {
      resize.disconnect();
      const elements = new Set<Element>([document.documentElement, document.body, element]);
      for (let parent = element.parentElement; parent; parent = parent.parentElement) elements.add(parent);
      if (popover) elements.add(popover.wrapper);
      for (const item of elements) resize.observe(item);
      schedule();
    }
    function updateButtons() {
      if (!popover) return;
      popover.previousButton.disabled = neighbor(-1) === undefined;
      popover.previousButton.classList.toggle('driver-popover-btn-disabled', popover.previousButton.disabled);
      popover.nextButton.textContent = neighbor(1) ? '下一步' : '完成引导';
    }
    function renderPopover(dom: PopoverDOM) {
      popover = dom; dom.wrapper.dataset.guidePopover = ''; dom.wrapper.dataset.guideStep = steps[cursor].id;
      dom.wrapper.setAttribute('role', 'dialog'); dom.wrapper.setAttribute('aria-label', '使用指南'); dom.wrapper.setAttribute('aria-modal', 'false');
      dom.wrapper.removeAttribute('aria-labelledby'); dom.wrapper.style.display = 'flex';
      dom.title.setAttribute('role', 'heading'); dom.title.setAttribute('aria-level', '2'); dom.title.tabIndex = -1;
      dom.progress.setAttribute('role', 'status'); dom.progress.setAttribute('aria-live', 'polite'); dom.footer.style.display = 'grid';
      dom.previousButton.classList.remove('driver-popover-footer-btn'); dom.nextButton.classList.remove('driver-popover-footer-btn');
      dom.previousButton.classList.add('button'); dom.nextButton.classList.add('button', 'button--primary');
      dom.previousButton.style.display = dom.nextButton.style.display = '';
      dom.closeButton.classList.add('icon-button'); dom.closeButton.setAttribute('aria-label', '关闭指引'); dom.closeButton.style.display = '';
      const skip = document.createElement('button'); skip.type = 'button'; skip.className = 'button button--ghost getting-started-guide__skip'; skip.textContent = '暂时跳过';
      skip.addEventListener('click', finish); dom.footer.insertBefore(skip, dom.footerButtons); updateButtons();
      cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() => { focusFrame = 0; if (!disposed && !nativeDialog() && dom.wrapper.isConnected) dom.title.focus({ preventScroll: true }); });
    }
    function reconcile() {
      if (disposed || finished) return;
      if (nativeDialog() || loading()) { if (tour) retireDriver(); return; }
      if (pending && settleFrames > 0) { settleFrames--; schedule(); return; }
      const candidates = resolvePlan();
      if (!candidates.length) { finish(); return; }
      if (cursor < 0) enter(candidates[0].order);
      else if (pending || !candidates.some(item => item.order === cursor)) {
        const next = neighbor(1, candidates);
        if (!next) { finish(); return; }
        enter(next.order);
      }
      const changed = plan.length !== candidates.length || plan.some((item, index) => item.order !== candidates[index].order || item.element !== candidates[index].element);
      plan = candidates;
      const index = plan.findIndex(item => item.order === cursor), current = plan[index];
      const driverSteps = plan.map(item => ({ element: item.element, popover: { title: item.definition.title, description: item.definition.description, side: item.definition.side ?? 'bottom', align: 'start' as const } }));
      if (!tour) {
        const tokens = getComputedStyle(document.documentElement);
        tour = driver({
          steps: driverSteps, animate: false, smoothScroll: false, allowScroll: true, allowClose: true,
          disableActiveInteraction: false, advanceOnClick: false, allowKeyboardControl: false, overlayClickBehavior: 'close',
          overlayColor: tokens.getPropertyValue('--overlay').trim(), overlayOpacity: 1,
          stagePadding: parseFloat(tokens.getPropertyValue('--space-2')), stageRadius: parseFloat(tokens.getPropertyValue('--radius-small')),
          popoverOffset: parseFloat(tokens.getPropertyValue('--space-3')), popoverClass: 'getting-started-guide-popover',
          showButtons: ['previous', 'next', 'close'], showProgress: true, progressText: '第 {{current}} 步，共 {{total}} 步',
          prevBtnText: '上一步', nextBtnText: '下一步', doneBtnText: '完成引导', closeBtnLabel: '关闭指引',
          onNextClick: () => move(1), onPrevClick: () => move(-1), onDoneClick: () => move(1), onCloseClick: finish,
          onPopoverRender: renderPopover, onHighlighted: element => { if (element) observeLayout(element); },
          onDestroyed: () => { if (!suspending) finish(); },
        });
        renderedOrder = cursor; renderedElement = current.element; tour.drive(index);
      } else if (changed || renderedOrder !== cursor || renderedElement !== current.element) {
        renderedOrder = cursor; renderedElement = current.element;
        tour.setConfig({ ...tour.getConfig(), steps: driverSteps }); tour.moveTo(index);
      } else { updateButtons(); tour.refresh(); }
    }
    mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'class', 'style', 'aria-hidden'] });
    document.addEventListener('scroll', schedule, true); document.addEventListener('click', schedule, true);
    window.addEventListener('resize', schedule); window.addEventListener('keydown', keyboard, true); schedule();
    return () => { disposed = true; stop(); retireDriver(); restoreFocus(); };
  }, []);

  return null;
}
