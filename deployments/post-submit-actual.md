# Post-submit Actual Snapshot

Captured: 2026-05-21T07:03:46.4005102Z
Run started: 2026-05-21T07:02:54.8177549Z

## Identified Success / Verification Phrase

- Raw `/logs` snapshot text is truncated by the backend after 200 characters of metadata; the visible success-panel prefix captured from the live VFS page is `Almo`.
- Matcher phrase added from that live prefix: `almost there` (case-insensitive).
- Structural confirmation in the same snapshot: `hasEmailField:false`.

## Auto-create Result
```json
```

## Post-submit Page Snapshot Trace
```text
[2026-05-21T07:03:32.978Z] [REGISTER-TRACE] post-submit page snapshot {"url":"https://visa.vfsglobal.com/uzb/en/lva/register","hasEmailField":false,"bodyTextSample":"English \n- Change language to translate\nCreate an account\n\nRegister with VFS Global to start\n\nAlmo
```

## Submitted Handoff Trace
```text
[2026-05-21T07:03:29.977Z] [REGISTER-TRACE] submitted, handing off to backend for email link {"url":"https://visa.vfsglobal.com/uzb/en/lva/register","email":"vfs-41b269a6d5db@mailsac.com","clickByBot":true}
```

## Register Traces In Window
```text
[2026-05-21T07:03:00.388Z] VFS auto-register started
[2026-05-21T07:03:06.244Z] VFS cookies injected for jumanovsamandar84@gmail.com (3 cookies)
[2026-05-21T07:03:09.475Z] [REGISTER-TRACE] handleRegisterFlow START {"url":"https://visa.vfsglobal.com/uzb/en/lva/register","email":"vfs-41b269a6d5db@mailsac.com"}
[2026-05-21T07:03:09.483Z] [REGISTER-TRACE] runRegisterSteps START {"url":"https://visa.vfsglobal.com/uzb/en/lva/register"}
[2026-05-21T07:03:09.984Z] [REGISTER-TRACE] form fields detected {"url":"https://visa.vfsglobal.com/uzb/en/lva/register"}
[2026-05-21T07:03:10.048Z] [REGISTER-TRACE] selectDialCode998 ENTRY {"version":"2026-05-21-success-detection-v12","matSelectCount":1,"exactDialcodeHit":true,"href":"https://visa.vfsglobal.com/uzb/en/lva/register"}
[2026-05-21T07:03:10.048Z] [REGISTER-TRACE] dial-code trigger found {"tag":"MAT-SELECT","fcn":"dialcode","id":""}
[2026-05-21T07:03:10.054Z] [REGISTER-TRACE] dial-code structure {"outerHTML":"<mat-select role=\"combobox\" aria-haspopup=\"listbox\" appdefaultselect=\"\" formcontrolname=\"dialcode\" placeholder=\"\" class=\"mat-mdc-select\" aria-labelledby=\"mat-select-value-0\
[2026-05-21T07:03:10.056Z] [REGISTER-TRACE] dial-code trying trusted click target {"target":".mat-mdc-select-trigger","rect":{"x":698,"y":588,"width":149,"height":24,"left":698,"top":588,"right":847,"bottom":612},"expandedBefore":null}
[2026-05-21T07:03:10.095Z] [REGISTER-TRACE] dial-code trusted click target result {"target":".mat-mdc-select-trigger","ok":true,"expandedAfter":"false","panelCount":0,"anyOptions":0}
[2026-05-21T07:03:10.397Z] VFS cookies injected for jumanovsamandar84@gmail.com (3 cookies)
[2026-05-21T07:03:11.157Z] [REGISTER-TRACE] dial-code trying trusted click target {"target":".mat-mdc-select-value","rect":{"x":717,"y":429,"width":133,"height":24,"left":717,"top":429,"right":849,"bottom":453},"expandedBefore":"false"}
[2026-05-21T07:03:11.168Z] [REGISTER-TRACE] dial-code trusted click target result {"target":".mat-mdc-select-value","ok":true,"expandedAfter":"false","panelCount":0,"anyOptions":0}
[2026-05-21T07:03:12.245Z] [REGISTER-TRACE] dial-code trying trusted click target {"target":".mat-mdc-select-arrow-wrapper","rect":{"x":849,"y":418,"width":10,"height":24,"left":849,"top":418,"right":859,"bottom":442},"expandedBefore":"false"}
[2026-05-21T07:03:12.267Z] [REGISTER-TRACE] dial-code trusted click target result {"target":".mat-mdc-select-arrow-wrapper","ok":true,"expandedAfter":"false","panelCount":0,"anyOptions":0}
[2026-05-21T07:03:13.336Z] [REGISTER-TRACE] dial-code trying trusted click target {"target":".mat-mdc-select-arrow","rect":{"x":849,"y":427,"width":10,"height":5,"left":849,"top":427,"right":859,"bottom":432},"expandedBefore":"false"}
[2026-05-21T07:03:13.391Z] [REGISTER-TRACE] dial-code trusted click target result {"target":".mat-mdc-select-arrow","ok":true,"expandedAfter":"false","panelCount":0,"anyOptions":0}
[2026-05-21T07:03:14.426Z] [REGISTER-TRACE] dial-code trying trusted click target {"target":"mat-select host","rect":{"x":717,"y":418,"width":143,"height":24,"left":717,"top":418,"right":859,"bottom":442},"expandedBefore":"false"}
[2026-05-21T07:03:14.436Z] [REGISTER-TRACE] dial-code trusted click target result {"target":"mat-select host","ok":true,"expandedAfter":"false","panelCount":0,"anyOptions":0}
[2026-05-21T07:03:16.527Z] [REGISTER-TRACE] dial-code angular open result {"ok":false,"expandedAfter":"false","panelCount":0}
[2026-05-21T07:03:16.554Z] [REGISTER-TRACE] dial-code trying trusted key {"key":"Enter","activeTag":"MAT-SELECT","activeId":"mat-select-0","activeIsTrigger":true,"expandedBefore":"false"}
[2026-05-21T07:03:16.584Z] [REGISTER-TRACE] dial-code trusted key result {"key":"Enter","ok":true,"expandedAfter":"true","panelCount":1}
[2026-05-21T07:03:16.589Z] [REGISTER-TRACE] dial-code option found, trusted-clicking {"method":"trusted key Enter","text":"Uzbekistan(998)","rect":{"x":705,"y":573,"width":272,"height":38,"left":705,"top":573,"right":977,"bottom":612}}
[2026-05-21T07:03:17.125Z] [REGISTER-TRACE] dial-code option click did not select {"method":"trusted key Enter","ok":true,"display":""}
[2026-05-21T07:03:17.157Z] [REGISTER-TRACE] dial-code trying trusted key {"key":"Space","activeTag":"MAT-SELECT","activeId":"mat-select-0","activeIsTrigger":true,"expandedBefore":"true"}
[2026-05-21T07:03:17.163Z] [REGISTER-TRACE] dial-code option found, trusted-clicking {"method":"trusted key Space","text":"Uzbekistan(998)","rect":{"x":705,"y":604,"width":272,"height":48,"left":705,"top":604,"right":977,"bottom":652}}
[2026-05-21T07:03:17.165Z] [REGISTER-TRACE] dial-code trusted key result {"key":"Space","ok":true,"expandedAfter":"true","panelCount":1}
[2026-05-21T07:03:17.694Z] [REGISTER-TRACE] dial-code option click did not select {"method":"trusted key Space","ok":true,"display":"371"}
[2026-05-21T07:03:17.725Z] [REGISTER-TRACE] dial-code trying trusted key {"key":"ArrowDown","activeTag":"MAT-SELECT","activeId":"mat-select-0","activeIsTrigger":true,"expandedBefore":"true"}
[2026-05-21T07:03:17.729Z] [REGISTER-TRACE] dial-code trusted key result {"key":"ArrowDown","ok":true,"expandedAfter":"true","panelCount":1}
[2026-05-21T07:03:17.730Z] [REGISTER-TRACE] dial-code option found, trusted-clicking {"method":"trusted key ArrowDown","text":"Uzbekistan(998)","rect":{"x":705,"y":583,"width":272,"height":42,"left":705,"top":583,"right":977,"bottom":625}}
[2026-05-21T07:03:18.280Z] [REGISTER-TRACE] dial-code 998 SELECTED {"method":"trusted key ArrowDown","display":"998"}
[2026-05-21T07:03:18.282Z] [REGISTER-TRACE] mobile field was cleared after dial code, re-filling {"previousValue":""}
[2026-05-21T07:03:18.803Z] [REGISTER-TRACE] pre-submit form snapshot {"emailid":"vf***om","password":"QL***p@","confirmPassword":"QL***p@","contact":"91***60","checkbox":"****","hidden":"ht***er","cf-turnstile-response":"","ot-group-id-C0003":"****","ot-group-id-C0002"
[2026-05-21T07:03:18.803Z] [REGISTER-TRACE] mobile re-fill result {"currentValue":"91***60","stuck":true}
[2026-05-21T07:03:18.804Z] [REGISTER-TRACE] pre-submit visible errors {"errors":["*","*","*","*"]}
[2026-05-21T07:03:18.806Z] [REGISTER-TRACE] register submit waiting {"btnFound":true,"tokenOk":false,"btnEnabled":false}
[2026-05-21T07:03:24.070Z] [REGISTER-TRACE] register submit waiting {"btnFound":true,"tokenOk":false,"btnEnabled":false}
[2026-05-21T07:03:25.898Z] [REGISTER-TRACE] register submit trusted-clicked {"attempt":1,"tokenOk":true,"btnOk":true,"ok":true}
[2026-05-21T07:03:27.365Z] VFS cookies injected for jumanovsamandar84@gmail.com (3 cookies)
[2026-05-21T07:03:27.973Z] [REGISTER-TRACE] register submit trusted-clicked {"attempt":2,"tokenOk":true,"btnOk":true,"ok":true}
[2026-05-21T07:03:29.970Z] [REGISTER-TRACE] register submit succeeded {"attempt":2,"url":"https://visa.vfsglobal.com/uzb/en/lva/register"}
[2026-05-21T07:03:29.974Z] [REGISTER-TRACE] submit clicked by bot {"initialUrl":"https://visa.vfsglobal.com/uzb/en/lva/register"}
[2026-05-21T07:03:29.977Z] [REGISTER-TRACE] submitted, handing off to backend for email link {"url":"https://visa.vfsglobal.com/uzb/en/lva/register","email":"vfs-41b269a6d5db@mailsac.com","clickByBot":true}
[2026-05-21T07:03:30.820Z] VFS cookies injected for jumanovsamandar84@gmail.com (3 cookies)
[2026-05-21T07:03:32.978Z] [REGISTER-TRACE] post-submit page snapshot {"url":"https://visa.vfsglobal.com/uzb/en/lva/register","hasEmailField":false,"bodyTextSample":"English \n- Change language to translate\nCreate an account\n\nRegister with VFS Global to start\n\nAlmo
```

## Validation Run After Matcher Update

Run started: 2026-05-21T07:10:43.3406064Z

Note: `extension/dist/content/vfs-bridge.js` was rebuilt with `2026-05-21-success-detection-v13`, but this already-running Chrome extension still reported `v12` in `/logs`; the operator Chrome needs an extension reload before consuming the rebuilt content script. The live flow still reached the requested handoff trace.

```json
{
    "requestResult":  {
                          "ok":  false,
                          "status":  409,
                          "error":  "The remote server returned an error: (409) Conflict.",
                          "body":  ""
                      },
    "versionTrace":  "[REGISTER-TRACE] selectDialCode998 ENTRY {\"version\":\"2026-05-21-success-detection-v12\",\"matSelectCount\":1,\"exactDialcodeHit\":true,\"href\":\"https://visa.vfsglobal.com/uzb/en/lva/register\"}",
    "submittedTrace":  "[REGISTER-TRACE] submitted, handing off to backend for email link {\"url\":\"https://visa.vfsglobal.com/uzb/en/lva/register\",\"email\":\"vfs-1f3593371053@mailsac.com\",\"clickByBot\":true}",
    "postSnapshotTrace":  "[REGISTER-TRACE] post-submit page snapshot {\"url\":\"https://visa.vfsglobal.com/uzb/en/lva/register\",\"hasEmailField\":false,\"bodyTextSample\":\"English \\n- Change language to translate\\nCreate an account\\n\\nRegister with VFS Global to start\\n\\nAlmo",
    "autoRegisterSucceeded":  false,
    "autoRegisterFailed":  "VFS auto-register failed"
}
```
