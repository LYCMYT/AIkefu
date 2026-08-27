import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import { BuyerMessageDto, BuyerOrderCardDto, BuyerProductCardDto, MessageEditDto } from '../common/request-dtos';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { MESSAGE_APPLICATION, type MessageApplication } from './message.application';

@Controller('buyers')
export class BuyersController {
  constructor(@Inject(MESSAGE_APPLICATION) private readonly messages: MessageApplication) {}

  @Get()
  list(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Query('shopId') shopId?: string) {
    return this.messages.listBuyers(scope, shopId);
  }
}

@Controller('conversations')
export class ConversationsController {
  constructor(@Inject(MESSAGE_APPLICATION) private readonly messages: MessageApplication) {}

  @Get()
  list(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Query('shopId') shopId?: string) {
    if (!shopId) throw inputError('SHOP_ID_REQUIRED', 'shopId is required');
    return this.messages.listConversations(scope, shopId);
  }

  @Get(':conversationId')
  get(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('conversationId') conversationId: string) {
    return this.messages.getConversation(scope, conversationId);
  }
}

@Controller('shops/:shopId')
export class ShopContextController {
  constructor(@Inject(MESSAGE_APPLICATION) private readonly messages: MessageApplication) {}

  @Get('products')
  products(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('shopId') shopId: string) {
    return this.messages.listProducts(scope, shopId);
  }

  @Get('orders')
  orders(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('shopId') shopId: string,
    @Query('buyerId') buyerId?: string,
  ) {
    return this.messages.listOrders(scope, shopId, buyerId);
  }
}

@Controller('buyer')
export class BuyerSimulatorController {
  constructor(@Inject(MESSAGE_APPLICATION) private readonly messages: MessageApplication) {}

  @Post('messages')
  @HttpCode(HttpStatus.ACCEPTED)
  send(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Body() input: BuyerMessageDto) {
    if (!input?.shopId || !input.buyerId || !input.kind) {
      throw inputError('MESSAGE_INPUT_INVALID', 'shopId, buyerId and kind are required');
    }
    if (input.kind === 'TEXT' && !input.text?.trim()) {
      throw inputError('MESSAGE_TEXT_REQUIRED', 'text is required for TEXT messages');
    }
    return this.messages.sendMessage(scope, input);
  }

  @Post('product-cards')
  @HttpCode(HttpStatus.ACCEPTED)
  productCard(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Body() input: BuyerProductCardDto) {
    if (!input?.shopId || !input.buyerId || !input.productId) {
      throw inputError('PRODUCT_CARD_INPUT_INVALID', 'shopId, buyerId and productId are required');
    }
    return this.messages.sendProductCard(scope, input);
  }

  @Post('cards/product')
  @HttpCode(HttpStatus.ACCEPTED)
  productCardContract(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Body() input: BuyerProductCardDto) {
    return this.productCard(scope, input);
  }

  @Post('order-cards')
  @HttpCode(HttpStatus.ACCEPTED)
  orderCard(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Body() input: BuyerOrderCardDto) {
    if (!input?.shopId || !input.buyerId || !input.orderId) {
      throw inputError('ORDER_CARD_INPUT_INVALID', 'shopId, buyerId and orderId are required');
    }
    return this.messages.sendOrderCard(scope, input);
  }

  @Post('cards/order')
  @HttpCode(HttpStatus.ACCEPTED)
  orderCardContract(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Body() input: BuyerOrderCardDto) {
    return this.orderCard(scope, input);
  }

  @Patch('messages/:messageId')
  @HttpCode(HttpStatus.ACCEPTED)
  edit(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('messageId') messageId: string,
    @Body() input: MessageEditDto,
  ) {
    if (!input?.text?.trim()) throw inputError('MESSAGE_TEXT_REQUIRED', 'text is required');
    return this.messages.editMessage(scope, messageId, input.text);
  }

  @Post('messages/:messageId/recall')
  @HttpCode(HttpStatus.ACCEPTED)
  recall(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('messageId') messageId: string) {
    return this.messages.recallMessage(scope, messageId);
  }
}

function inputError(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}
