import {existsSync} from 'node:fs';
import {resolveBlankTemplate} from '../scripts/blank-template.mjs';
import {templateCandidates} from '../scripts/version.mjs';

export function nativeTemplateSkipReason(){
  try{resolveBlankTemplate(9);return false;}
  catch(error){
    // A configured or existing but invalid fixture must fail, not turn green.
    if(process.env.AXURE_BLANK_TEMPLATE||process.env.AXURE_BLANK_TEMPLATE_RP9||templateCandidates(9).some(item=>existsSync(item.path)))throw error;
    return '需要本机用户保存的RP9空白模板；此环境不执行原生文件验证';
  }
}
